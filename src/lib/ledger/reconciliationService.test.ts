import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createFullLedgerTestContext } from "./integrationTestFakes";

const PAYER = { profileKind: "personal" as const, profileId: randomUUID() };
const RECIPIENT = { profileKind: "business" as const, profileId: randomUUID() };

describe("ReconciliationService", () => {
  let ctx: ReturnType<typeof createFullLedgerTestContext>;

  beforeEach(() => {
    ctx = createFullLedgerTestContext();
  });

  async function insertPayment(overrides: Partial<Parameters<typeof ctx.paymentCtx.payments.insertPending>[0]> = {}) {
    return ctx.paymentCtx.payments.insertPending({
      idempotencyKey: randomUUID(),
      payerProfileKind: PAYER.profileKind,
      payerProfileId: PAYER.profileId,
      recipientProfileKind: RECIPIENT.profileKind,
      recipientProfileId: RECIPIENT.profileId,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: randomUUID(),
      providerName: "sandbox_mock",
      ...overrides,
    });
  }

  it("finds no exceptions for a payment that never advanced past pending", async () => {
    const payment = await insertPayment();
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found).toHaveLength(0);
  });

  it("finds no exceptions for a fully, correctly processed payment (reconciliation success)", async () => {
    const created = await ctx.paymentCtx.provider.createPayment({
      idempotencyKey: "clean-1",
      amountMinorUnits: 5_000,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
      simulateOutcome: "succeeded",
    });
    const payment = await insertPayment({ amountMinorUnits: 5_000, currency: "USD" });
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: created.providerPaymentId });
    await ctx.ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: payment.id,
      agreementId: payment.agreementId!,
      currency: payment.currency,
      grossAmountMinorUnits: payment.amountMinorUnits,
    });

    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found).toHaveLength(0);
  });

  it("detects missing_provider_transaction: status advanced but no provider reference was ever captured", async () => {
    const payment = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", {});
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("missing_provider_transaction");
  });

  it("detects unmatched_provider_transaction: our record references a provider id the provider itself doesn't recognize", async () => {
    const payment = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: "sandbox_pay_never_existed" });
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("unmatched_provider_transaction");
  });

  it("detects status_mismatch: our status disagrees with the provider's own status for the same id", async () => {
    const created = await ctx.paymentCtx.provider.createPayment({
      idempotencyKey: "sm-1",
      amountMinorUnits: 5_000,
      currency: "USD",
      payer: PAYER,
      recipient: RECIPIENT,
      // defaults to "pending" and stays pending — never told the provider it succeeded
    });
    const payment = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: created.providerPaymentId });
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("status_mismatch");
  });

  it("detects amount_mismatch and currency_mismatch from a webhook event's payload", async () => {
    const payment = await insertPayment({ amountMinorUnits: 5_000, currency: "USD" });
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: "sandbox_pay_mismatch" });
    await ctx.webhookCtx.events.tryInsertAndClaim({
      provider: "sandbox_mock",
      providerEventId: "evt-mismatch",
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId: "sandbox_pay_mismatch", amountMinorUnits: 4_999, currency: "EUR" },
      leaseMs: 120_000,
      now: new Date(),
    });
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toEqual(
      expect.arrayContaining(["amount_mismatch", "currency_mismatch", "unmatched_provider_transaction"]),
    );
  });

  it("detects internal_posting_failure: status says succeeded but no ledger entry backs it", async () => {
    const payment = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: "sandbox_pay_gap" });
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
  });

  it("detects stale_pending_settlement for a payment stuck pending well past a realistic settlement window", async () => {
    const payment = await insertPayment();
    ctx.paymentCtx.payments.setCreatedAt(payment.id, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("stale_pending_settlement");
  });

  it("detects reversal_refund_mismatch: a reversing ledger entry exists but the payment status was never synced", async () => {
    const payment = await insertPayment();
    await ctx.ledgerCtx.ledgerService.postPaymentCleared({
      paymentAttemptId: payment.id,
      agreementId: payment.agreementId!,
      currency: payment.currency,
      grossAmountMinorUnits: payment.amountMinorUnits,
    });
    await ctx.ledgerCtx.ledgerService.reversePayment({ paymentAttemptId: payment.id, entryType: "refund", reason: "x" });
    // Status was never moved to "refunded" — simulates a bug/gap in the sync between ledger and payment_attempt.
    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("reversal_refund_mismatch");
  });

  it("detects duplicate_transaction across two payment_attempts sharing a provider_payment_id", async () => {
    const a = await insertPayment();
    const b = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(a.id, "succeeded", { providerPaymentId: "sandbox_pay_shared" });
    await ctx.paymentCtx.payments.updateStatus(b.id, "succeeded", { providerPaymentId: "sandbox_pay_shared" });
    const found = await ctx.reconciliationService.reconcileAll();
    const duplicates = found.filter((e) => e.exceptionType === "duplicate_transaction");
    expect(duplicates.length).toBeGreaterThanOrEqual(2);
  });

  it("detects provider_event_without_internal_state for an orphaned webhook event", async () => {
    await ctx.webhookCtx.events.tryInsertAndClaim({
      provider: "sandbox_mock",
      providerEventId: "evt-orphan",
      eventType: "payment.succeeded",
      source: "webhook",
      signatureVerified: true,
      payload: { providerPaymentId: "sandbox_pay_orphan" },
      leaseMs: 120_000,
      now: new Date(),
    });
    const found = await ctx.reconciliationService.reconcileAll();
    expect(found.map((e) => e.exceptionType)).toContain("provider_event_without_internal_state");
  });

  it("is idempotent: reconciling the same broken payment twice records exactly one open exception", async () => {
    const payment = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", {});
    await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
    expect(exceptions.filter((e) => e.exceptionType === "missing_provider_transaction")).toHaveLength(1);
  });

  it("reconcileAll is idempotent across repeated full runs too", async () => {
    const payment = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", {});
    await ctx.reconciliationService.reconcileAll();
    await ctx.reconciliationService.reconcileAll();
    const exceptions = await ctx.exceptions.listForPaymentAttempt(payment.id);
    expect(exceptions.filter((e) => e.exceptionType === "missing_provider_transaction")).toHaveLength(1);
  });

  // R09 (payment -> ledger -> agreement-lifecycle consistency/recovery) — corrective pass: reconciliation
  // must attempt SAFE AUTOMATIC REPAIR before ever recording internal_posting_failure; see
  // ReconciliationService.tryRepairMissingLedgerEntry's own doc comment for exactly which sources
  // are trusted enough to repair from.
  describe("R09: safe automatic repair", () => {
    it("repairs a missing payment_cleared entry for a manual off-platform payment, reconstructed only from the payment's own trusted fields", async () => {
      const payment = await insertPayment({ amountMinorUnits: 5_000, currency: "USD", paymentMethod: "manual_off_platform", initialStatus: "succeeded" });

      const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      expect(found.map((e) => e.exceptionType)).not.toContain("internal_posting_failure");

      const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

      // Re-running must never duplicate the repair.
      await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      const entriesAfterSecondRun = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
      expect(entriesAfterSecondRun.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    });

    it("repairs a missing payment_cleared entry for a provider-routed payment by reconstructing it from the trusted, already-processed payment.succeeded webhook payload — processor fee from provider evidence, platform fee from PlatformFeePolicy, never the payload", async () => {
      const payment = await insertPayment({ amountMinorUnits: 5_000, currency: "USD" });
      await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: "sandbox_pay_trusted_repair" });
      const inserted = await ctx.webhookCtx.events.tryInsertAndClaim({
        provider: "sandbox_mock",
        providerEventId: "evt-trusted-repair",
        eventType: "payment.succeeded",
        source: "webhook",
        signatureVerified: true,
        payload: {
          providerPaymentId: "sandbox_pay_trusted_repair",
          amountMinorUnits: 5_000,
          currency: "USD",
          processorFeeMinorUnits: 100,
          // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 5): an arbitrary, WRONG external
          // platformFeeMinorUnits — repair must never read this; the provider is not the authority for
          // Paid2You's own fee.
          platformFeeMinorUnits: 999_999,
        },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.webhookCtx.events.markProcessed(inserted!.id, inserted!.claimToken!, new Date());

      const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      expect(found.map((e) => e.exceptionType)).not.toContain("internal_posting_failure");

      const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
      const clearEntry = entries.find((e) => e.entryType === "payment_cleared");
      expect(clearEntry).toBeDefined();
      // Processor fee remains PROVIDER-authoritative — reconstructed from the trusted payload.
      const processorLeg = clearEntry!.postings.find((p) => p.accountType === "processor_fee_expense");
      expect(processorLeg?.amountMinorUnits).toBe(100);
      // Platform fee is Paid2You-OWNED — the default policy's own 0, NEVER the payload's 999_999.
      const platformLeg = clearEntry!.postings.find((p) => p.accountType === "platform_fee_revenue");
      expect(platformLeg).toBeUndefined();
    });

    it("does NOT repair, and correctly records internal_posting_failure for manual review, when no trusted processed event can be found", async () => {
      const payment = await insertPayment();
      await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: "sandbox_pay_gap_no_trusted_event" });
      const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
      const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(0);
    });

    it("repairs a missing reversal entry (refund) for a provider-routed payment from its trusted, already-processed payment.refunded webhook payload", async () => {
      const payment = await insertPayment({ amountMinorUnits: 5_000, currency: "USD" });
      await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: "sandbox_pay_refund_repair" });
      await ctx.ledgerCtx.ledgerService.postPaymentCleared({
        paymentAttemptId: payment.id,
        agreementId: payment.agreementId!,
        currency: payment.currency,
        grossAmountMinorUnits: payment.amountMinorUnits,
      });
      await ctx.paymentCtx.payments.updateStatus(payment.id, "refunded", {});
      const inserted = await ctx.webhookCtx.events.tryInsertAndClaim({
        provider: "sandbox_mock",
        providerEventId: "evt-refund-repair",
        eventType: "payment.refunded",
        source: "webhook",
        signatureVerified: true,
        payload: { providerPaymentId: "sandbox_pay_refund_repair", reason: "customer requested", amountMinorUnits: 5_000, currency: "USD" },
        leaseMs: 120_000,
        now: new Date(),
      });
      await ctx.webhookCtx.events.markProcessed(inserted!.id, inserted!.claimToken!, new Date());

      const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      expect(found.map((e) => e.exceptionType)).not.toContain("internal_posting_failure");
      const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
      expect(entries.filter((e) => e.entryType === "refund")).toHaveLength(1);

      await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      const entriesAfterSecondRun = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
      expect(entriesAfterSecondRun.filter((e) => e.entryType === "refund")).toHaveLength(1);
    });

    it("repairs a missed agreement-lifecycle consequence (ledger cleared, agreement never advanced) idempotently", async () => {
      const agreement = await ctx.agreementRepo.insert({
        creditorProfileKind: RECIPIENT.profileKind,
        creditorProfileId: RECIPIENT.profileId,
        debtorProfileKind: PAYER.profileKind,
        debtorProfileId: PAYER.profileId,
        currency: "USD",
        createdByUserId: "creator-1",
      });
      await ctx.agreementRepo.updateStatus(agreement.id, "first_payment_pending");
      // Principal exceeds this one payment so the balance settles "partially_paid" (-> "active"),
      // not "paid_in_full" — isolates the "FirstPaymentPending -> Active" edge this test targets.
      ctx.balanceCtx.terms.set(agreement.id, 10_000, "USD");
      const payment = await insertPayment({ agreementId: agreement.id, amountMinorUnits: 5_000, currency: "USD" });
      await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", { providerPaymentId: "sandbox_pay_lifecycle_repair" });
      // Ledger cleared directly (bypassing the webhook's own completion check) — models "ledger
      // committed but the agreement-lifecycle consequence never ran" (e.g. a crash in between).
      await ctx.ledgerCtx.ledgerService.postPaymentCleared({
        paymentAttemptId: payment.id,
        agreementId: agreement.id,
        currency: payment.currency,
        grossAmountMinorUnits: payment.amountMinorUnits,
      });
      expect((await ctx.agreementRepo.findById(agreement.id))?.status).toBe("first_payment_pending");

      await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      expect((await ctx.agreementRepo.findById(agreement.id))?.status).toBe("active");

      // Idempotent: re-running must not error or regress the status.
      await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
      expect((await ctx.agreementRepo.findById(agreement.id))?.status).toBe("active");
    });
  });

  it("resolves an exception, removing it from the open list", async () => {
    const payment = await insertPayment();
    await ctx.paymentCtx.payments.updateStatus(payment.id, "succeeded", {});
    const [exception] = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(exception).toBeDefined();
    const beforeOpen = await ctx.reconciliationService.listOpenExceptions();
    expect(beforeOpen.map((e) => e.id)).toContain(exception!.id);

    const resolved = await ctx.reconciliationService.resolveException(exception!.id, "admin-1", "Investigated, was a test fixture.");
    expect(resolved.status).toBe("resolved");
    const afterOpen = await ctx.reconciliationService.listOpenExceptions();
    expect(afterOpen.map((e) => e.id)).not.toContain(exception!.id);
  });
});
