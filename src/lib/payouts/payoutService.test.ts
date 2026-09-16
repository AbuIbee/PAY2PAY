import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CreditorNotVerifiedError, ProviderNotAvailableError, ValidationError } from "@/lib/errors";
import { createTestLedgerService } from "@/lib/ledger/testFakes";
import { InMemoryPaymentAttemptRepository } from "@/lib/payments/testFakes";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { createTestPayoutService } from "./testFakes";

const AGREEMENT_ID = "agreement-payout-1";

/**
 * PAID2YOU — B0-D PHASE 3A (eliminate fictional payouts). Proves the provider-independent payout
 * lifecycle `PayoutService` implements: a bare internal ledger posting can never, by itself, mark a
 * creditor paid; payout completion requires real provider evidence that no code path in this phase can
 * ever supply (fail-closed); a failed payout preserves the creditor's own liability untouched; and
 * duplicate/replayed calls never duplicate a financial effect.
 */
describe("PayoutService (PAID2YOU — B0-D PHASE 3A)", () => {
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let payments: InMemoryPaymentAttemptRepository;
  let payoutCtx: ReturnType<typeof createTestPayoutService>;

  async function seedClearedPayment(amountMinorUnits = 5_000) {
    const payment = await payments.insertPending({
      idempotencyKey: randomUUID(),
      payerProfileKind: "personal",
      payerProfileId: "payer-1",
      recipientProfileKind: "business",
      recipientProfileId: "creditor-1",
      amountMinorUnits,
      currency: "USD",
      agreementId: AGREEMENT_ID,
      providerName: "adyen",
      initialStatus: "succeeded",
    });
    await ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: payment.id,
      agreementId: AGREEMENT_ID,
      currency: "USD",
      grossAmountMinorUnits: amountMinorUnits,
    });
    return payment;
  }

  async function creditorLiability(paymentAttemptId: string) {
    const entries = await ledgerCtx.entries.listForPaymentAttempt(paymentAttemptId);
    return entries
      .flatMap((e) => e.postings)
      .filter((p) => p.accountType === "creditor_proceeds_payable")
      .reduce((sum, p) => sum + (p.direction === "credit" ? p.amountMinorUnits : -p.amountMinorUnits), 0);
  }

  async function payoutEntriesFor(paymentAttemptId: string, entryType: "payout" | "payout_returned") {
    const entries = await ledgerCtx.entries.listForPaymentAttempt(paymentAttemptId);
    return entries.filter((e) => e.entryType === entryType);
  }

  beforeEach(() => {
    ledgerCtx = createTestLedgerService();
    payments = new InMemoryPaymentAttemptRepository();
    payoutCtx = createTestPayoutService({ ledger: ledgerCtx.ledgerService, payments });
  });

  describe("recordPayoutOwed", () => {
    it("creates a pending payout_attempt, never posting anything to the ledger or marking the payment paid", async () => {
      const payment = await seedClearedPayment();
      const attempt = await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      expect(attempt.status).toBe("pending");
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
      expect(await payoutEntriesFor(payment.id, "payout")).toHaveLength(0);
    });

    it("is idempotent — a duplicate call for the same paymentAttemptId returns the existing row, never a second one", async () => {
      const payment = await seedClearedPayment();
      const first = await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      const second = await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      expect(second.id).toBe(first.id);
      expect(payoutCtx.payoutAttempts.byId.size).toBe(1);
    });
  });

  describe("REGRESSION: internal ledger posting cannot mark a creditor paid", () => {
    it("calling LedgerService.postPayout directly posts the ledger entry but does NOT mark payment_attempt.payoutCompletedAt — only PayoutService.confirmPayout may do that", async () => {
      const payment = await seedClearedPayment();
      await ledgerCtx.ledgerService.postPayout({ paymentAttemptId: payment.id });
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
    });

    it("no payout_attempt ever reaches \"confirmed\" as a side effect of ANY ledger operation — only confirmPayout's own explicit call can do that", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await ledgerCtx.ledgerService.postPayout({ paymentAttemptId: payment.id });
      const attempt = await payoutCtx.payoutService.getPayoutStatus(payment.id);
      expect(attempt?.status).toBe("pending");
    });
  });

  describe("REGRESSION: missing provider evidence blocks payout execution (fail-closed)", () => {
    it("confirmPayout throws when no payout_attempt was ever recorded as owed", async () => {
      const payment = await seedClearedPayment();
      await expect(
        payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(ValidationError);
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
    });

    it("confirmPayout throws when providerName is empty — never confirms from bare intent alone", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await expect(
        payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(ValidationError);
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
    });

    it("confirmPayout throws when providerPayoutReference is empty", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await expect(
        payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "  " }),
      ).rejects.toThrow(ValidationError);
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
    });
  });

  describe("confirmPayout (the only real completion path)", () => {
    it("posts the payout ledger entry and marks payoutCompletedAt, given real provider evidence", async () => {
      const payment = await seedClearedPayment(5_000);
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      const confirmed = await payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_transfer_123" });
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.providerPayoutReference).toBe("psp_transfer_123");
      expect((await payments.findById(payment.id))?.payoutCompletedAt).not.toBeNull();
      expect(await payoutEntriesFor(payment.id, "payout")).toHaveLength(1);
    });

    it("DUPLICATE COMPLETION: a second confirmPayout call for the same payment is idempotent — never a second ledger entry, never a second audit-visible financial effect", async () => {
      const payment = await seedClearedPayment(5_000);
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      const first = await payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_1" });
      const second = await payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_1" });
      expect(second.confirmedAt).toEqual(first.confirmedAt);
      expect(await payoutEntriesFor(payment.id, "payout")).toHaveLength(1);
    });

    it("cannot confirm a payout that is not pending (e.g. already failed)", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await payoutCtx.payoutService.failPayout({ paymentAttemptId: payment.id, reason: "no provider" });
      await expect(
        payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("PAID2YOU — B0-D PHASE 3B (payout integrity): PAYOUT_PROVIDER_INTEGRATION_VERIFIED is a second, independent gate", () => {
    it("confirmPayout throws ProviderNotAvailableError when the integration flag is false, even with a real pending attempt and valid-looking provider evidence", async () => {
      const unverified = createTestPayoutService({ ledger: ledgerCtx.ledgerService, payments, payoutProviderIntegrationVerified: false });
      const payment = await seedClearedPayment(5_000);
      await unverified.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      await expect(
        unverified.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_transfer_1" }),
      ).rejects.toThrow(ProviderNotAvailableError);

      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
      const attempt = await unverified.payoutService.getPayoutStatus(payment.id);
      expect(attempt?.status).toBe("pending");
      expect(await payoutEntriesFor(payment.id, "payout")).toHaveLength(0);
      expect(unverified.auditRepo.events).toHaveLength(0);
    });

    it("confirmPayout still throws ProviderNotAvailableError with the flag false even when no payout_attempt was ever recorded as owed — the integration gate is checked before any repository lookup", async () => {
      const unverified = createTestPayoutService({ ledger: ledgerCtx.ledgerService, payments, payoutProviderIntegrationVerified: false });
      const payment = await seedClearedPayment();
      await expect(
        unverified.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(ProviderNotAvailableError);
    });

    it("the integration flag does not gate recordPayoutOwed or failPayout — those keep working honestly with no live provider configured", async () => {
      const unverified = createTestPayoutService({ ledger: ledgerCtx.ledgerService, payments, payoutProviderIntegrationVerified: false });
      const payment = await seedClearedPayment(5_000);
      const owed = await unverified.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      expect(owed.status).toBe("pending");

      const failed = await unverified.payoutService.failPayout({ paymentAttemptId: payment.id, reason: "no live provider integration yet" });
      expect(failed.status).toBe("failed");
      expect(await creditorLiability(payment.id)).toBe(5_000); // untouched — still owed.
    });

    it("once the flag is true, confirmPayout succeeds exactly as PHASE 3A's own tests already prove (regression guard: the new gate does not block the real path)", async () => {
      const verified = createTestPayoutService({ ledger: ledgerCtx.ledgerService, payments, payoutProviderIntegrationVerified: true });
      const payment = await seedClearedPayment(5_000);
      await verified.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      const confirmed = await verified.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "psp_transfer_2" });
      expect(confirmed.status).toBe("confirmed");
      expect((await payments.findById(payment.id))?.payoutCompletedAt).not.toBeNull();
    });
  });

  describe("REGRESSION: failed payout preserves creditor liability", () => {
    it("failPayout posts nothing to the ledger — the creditor_proceeds_payable liability from payment_cleared is completely untouched", async () => {
      const payment = await seedClearedPayment(5_000);
      const liabilityBefore = await creditorLiability(payment.id);
      expect(liabilityBefore).toBe(5_000);

      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      const failed = await payoutCtx.payoutService.failPayout({ paymentAttemptId: payment.id, reason: "provider rejected transfer" });

      expect(failed.status).toBe("failed");
      expect(failed.failureReason).toBe("provider rejected transfer");
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
      expect(await creditorLiability(payment.id)).toBe(liabilityBefore); // unchanged — still owed.
      expect(await payoutEntriesFor(payment.id, "payout")).toHaveLength(0);
    });

    it("failPayout is idempotent", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      const first = await payoutCtx.payoutService.failPayout({ paymentAttemptId: payment.id, reason: "first reason" });
      const second = await payoutCtx.payoutService.failPayout({ paymentAttemptId: payment.id, reason: "ignored second reason" });
      expect(second.failureReason).toBe(first.failureReason);
    });

    it("cannot fail a payout that is not pending (e.g. already confirmed)", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" });
      await expect(payoutCtx.payoutService.failPayout({ paymentAttemptId: payment.id, reason: "too late" })).rejects.toThrow(ValidationError);
    });
  });

  describe("returnPayout", () => {
    it("reverses a confirmed payout, reinstating the creditor's liability", async () => {
      const payment = await seedClearedPayment(5_000);
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" });
      expect(await creditorLiability(payment.id)).toBe(0); // paid out — no longer owed.

      const returned = await payoutCtx.payoutService.returnPayout({ paymentAttemptId: payment.id, reason: "bank returned the transfer" });
      expect(returned.status).toBe("returned");
      expect(await creditorLiability(payment.id)).toBe(5_000); // liability reinstated.
    });

    it("PAID2YOU — B0-D PHASE 3B (G3 correction): clears payment_attempt.payoutCompletedAt, so a reversed payout no longer shows a stale 'completed' indicator", async () => {
      const payment = await seedClearedPayment(5_000);
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" });
      expect((await payments.findById(payment.id))?.payoutCompletedAt).not.toBeNull();

      await payoutCtx.payoutService.returnPayout({ paymentAttemptId: payment.id, reason: "bank returned the transfer" });
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
    });

    it("cannot return a payout that was never confirmed", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await expect(payoutCtx.payoutService.returnPayout({ paymentAttemptId: payment.id, reason: "x" })).rejects.toThrow(ValidationError);
    });

    it("is idempotent", async () => {
      const payment = await seedClearedPayment();
      await payoutCtx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });
      await payoutCtx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" });
      const first = await payoutCtx.payoutService.returnPayout({ paymentAttemptId: payment.id, reason: "first" });
      const second = await payoutCtx.payoutService.returnPayout({ paymentAttemptId: payment.id, reason: "ignored" });
      expect(second.returnedAt).toEqual(first.returnedAt);
      expect(await payoutEntriesFor(payment.id, "payout_returned")).toHaveLength(1);
    });
  });

  describe("PAID2YOU — B0-D PHASE 3C (creditor payout eligibility)", () => {
    const CREDITOR_KIND = "business" as const;
    const CREDITOR_ID = "creditor-1"; // matches seedClearedPayment's own recipientProfileId.

    function buildCtxWithVerification(overrides: { payoutProviderIntegrationVerified?: boolean } = {}) {
      const verificationCtx = createTestVerificationService();
      const ctx = createTestPayoutService({
        ledger: ledgerCtx.ledgerService,
        payments,
        verification: verificationCtx.verificationService,
        payoutProviderIntegrationVerified: overrides.payoutProviderIntegrationVerified ?? true,
      });
      return { verificationCtx, ...ctx };
    }

    it("recordPayoutOwed is NEVER gated by creditor verification — an UNVERIFIED creditor's liability and pending payout obligation are established exactly as normal", async () => {
      const ctx = buildCtxWithVerification();
      const payment = await seedClearedPayment(5_000);

      const owed = await ctx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      expect(owed.status).toBe("pending");
      expect(await creditorLiability(payment.id)).toBe(5_000); // the liability a cleared payment establishes is unconditional.
    });

    it("confirmPayout fails closed with CreditorNotVerifiedError when the creditor has NO verification record at all", async () => {
      const ctx = buildCtxWithVerification();
      const payment = await seedClearedPayment(5_000);
      await ctx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      await expect(
        ctx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(CreditorNotVerifiedError);

      // No premature payout, ledger mutation, or completed status.
      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
      expect((await ctx.payoutService.getPayoutStatus(payment.id))?.status).toBe("pending");
      expect(await creditorLiability(payment.id)).toBe(5_000);
      expect(await payoutEntriesFor(payment.id, "payout")).toHaveLength(0);
    });

    it("confirmPayout fails closed with CreditorNotVerifiedError when the creditor's FULL verification is still PENDING (submitted, not yet decided)", async () => {
      const ctx = buildCtxWithVerification();
      await ctx.verificationCtx.records.insert({ profileKind: CREDITOR_KIND, profileId: CREDITOR_ID, tier: "full" }); // status defaults "pending".
      const payment = await seedClearedPayment(5_000);
      await ctx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      await expect(
        ctx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(CreditorNotVerifiedError);
    });

    it("confirmPayout fails closed with CreditorNotVerifiedError when the creditor's FULL verification was REJECTED", async () => {
      const ctx = buildCtxWithVerification();
      const rec = await ctx.verificationCtx.records.insert({ profileKind: CREDITOR_KIND, profileId: CREDITOR_ID, tier: "full" });
      await ctx.verificationCtx.records.updateDecision(rec.id, { status: "rejected", reviewerUserId: randomUUID(), reason: "could not confirm identity" });
      const payment = await seedClearedPayment(5_000);
      await ctx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      await expect(
        ctx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(CreditorNotVerifiedError);
    });

    it("confirmPayout fails closed when FULL verification exists only for a DIFFERENT profile — another user's verification never satisfies THIS creditor's eligibility", async () => {
      const ctx = buildCtxWithVerification();
      const rec = await ctx.verificationCtx.records.insert({ profileKind: CREDITOR_KIND, profileId: "some-other-business-9999", tier: "full" });
      await ctx.verificationCtx.records.updateDecision(rec.id, { status: "verified", reviewerUserId: randomUUID(), reason: null });
      const payment = await seedClearedPayment(5_000);
      await ctx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      await expect(
        ctx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(CreditorNotVerifiedError);
      expect(await creditorLiability(payment.id)).toBe(5_000); // still owed — no premature payout.
    });

    it("approved FULL verification satisfies ONLY internal eligibility — confirmPayout still fails closed with ProviderNotAvailableError when no live payout provider is verified, regardless of creditor verification", async () => {
      const ctx = buildCtxWithVerification({ payoutProviderIntegrationVerified: false }); // missing provider.
      const rec = await ctx.verificationCtx.records.insert({ profileKind: CREDITOR_KIND, profileId: CREDITOR_ID, tier: "full" });
      await ctx.verificationCtx.records.updateDecision(rec.id, { status: "verified", reviewerUserId: randomUUID(), reason: null });
      const payment = await seedClearedPayment(5_000);
      await ctx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      await expect(
        ctx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" }),
      ).rejects.toThrow(ProviderNotAvailableError);

      expect((await payments.findById(payment.id))?.payoutCompletedAt).toBeNull();
      expect((await ctx.payoutService.getPayoutStatus(payment.id))?.status).toBe("pending");
      expect(await creditorLiability(payment.id)).toBe(5_000);
      expect(await payoutEntriesFor(payment.id, "payout")).toHaveLength(0);
    });

    it("regression: a creditor who is BOTH fully verified AND has a verified payout provider can be confirmed — the two independent gates compose, they don't just block", async () => {
      const ctx = buildCtxWithVerification({ payoutProviderIntegrationVerified: true });
      const rec = await ctx.verificationCtx.records.insert({ profileKind: CREDITOR_KIND, profileId: CREDITOR_ID, tier: "full" });
      await ctx.verificationCtx.records.updateDecision(rec.id, { status: "verified", reviewerUserId: randomUUID(), reason: null });
      const payment = await seedClearedPayment(5_000);
      await ctx.payoutService.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId: AGREEMENT_ID });

      const confirmed = await ctx.payoutService.confirmPayout({ paymentAttemptId: payment.id, providerName: "adyen", providerPayoutReference: "ref-1" });
      expect(confirmed.status).toBe("confirmed");
    });
  });
});
