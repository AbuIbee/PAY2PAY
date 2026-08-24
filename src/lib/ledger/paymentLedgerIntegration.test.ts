import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createFullLedgerTestContext } from "./integrationTestFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-profile-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recipient-profile-1" };
const PAYER_USER_ID = "payer-user-1";
const RECIPIENT_USER_ID = "recipient-user-1";
const REVIEWER_USER_ID = "reviewer-1";

describe("Payment webhook -> ledger integration (Sprint 10)", () => {
  let ctx: ReturnType<typeof createFullLedgerTestContext>;

  beforeEach(async () => {
    ctx = createFullLedgerTestContext();
    ctx.paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    ctx.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    for (const ref of [PAYER, RECIPIENT]) {
      await ctx.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await ctx.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
  });

  async function createPayment(idempotencyKey: string, agreementId: string, amountMinorUnits = 10_000) {
    return ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits,
      currency: "USD",
      agreementId,
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
  }

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: ctx.paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  it("posts payment_cleared, including processor fee and platform fee legs, on payment.succeeded", async () => {
    const agreementId = "agreement-1";
    const payment = await createPayment("k1", agreementId, 10_200);
    const event = signedWebhook({
      providerEventId: "evt-1",
      eventType: "payment.succeeded",
      providerPaymentId: payment.providerPaymentId,
      processorFeeMinorUnits: 150,
      platformFeeMinorUnits: 50,
    });
    const result = await ctx.webhookCtx.paymentWebhookService.receiveWebhook(event);
    expect(result.status).toBe("processed");

    const updated = await ctx.paymentCtx.payments.findById(payment.id);
    expect(updated?.status).toBe("succeeded");

    const entry = await ctx.ledgerCtx.ledgerService.findEntry(payment.id, "payment_cleared");
    expect(entry).not.toBeNull();
    const byType = Object.fromEntries(entry!.postings.map((p) => [p.accountType, p.amountMinorUnits]));
    expect(byType.processor_clearing).toBe(10_200);
    expect(byType.processor_fee_expense).toBe(150);
    expect(byType.platform_fee_revenue).toBe(50);
    expect(byType.creditor_proceeds_payable).toBe(10_000);
  });

  it("a redelivered/duplicate webhook never double-credits or double-debits (requirement #12)", async () => {
    const agreementId = "agreement-2";
    ctx.balanceCtx.terms.set(agreementId, 5_000, "USD");
    const payment = await createPayment("k2", agreementId, 5_000);
    const event = signedWebhook({ providerEventId: "evt-2", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId });

    const first = await ctx.webhookCtx.paymentWebhookService.receiveWebhook(event);
    const second = await ctx.webhookCtx.paymentWebhookService.receiveWebhook(event);
    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");

    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(5_000);
  });

  it("a failed payment posts no ledger entry and does not reduce the outstanding balance (requirement #13)", async () => {
    const agreementId = "agreement-3";
    ctx.balanceCtx.terms.set(agreementId, 5_000, "USD");
    const payment = await createPayment("k3", agreementId, 5_000);
    const event = signedWebhook({ providerEventId: "evt-3", eventType: "payment.failed", providerPaymentId: payment.providerPaymentId });
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(event);

    const updated = await ctx.paymentCtx.payments.findById(payment.id);
    expect(updated?.status).toBe("failed");
    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
    expect(entries).toHaveLength(0);

    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.remainingBalanceMinorUnits).toBe(5_000);
  });

  it("posts a refund reversal on payment.refunded, after a prior payment.succeeded", async () => {
    const agreementId = "agreement-4";
    ctx.balanceCtx.terms.set(agreementId, 5_000, "USD");
    const payment = await createPayment("k4", agreementId, 5_000);
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-4a", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }),
    );
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-4b", eventType: "payment.refunded", providerPaymentId: payment.providerPaymentId, reason: "buyer request" }),
    );

    const updated = await ctx.paymentCtx.payments.findById(payment.id);
    expect(updated?.status).toBe("refunded");
    const refundEntry = await ctx.ledgerCtx.ledgerService.findEntry(payment.id, "refund");
    expect(refundEntry?.reason).toBe("buyer request");

    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.reversedMinorUnits).toBe(5_000);
  });

  it("posts a reversal on payment.returned and sets status to returned", async () => {
    const agreementId = "agreement-5";
    const payment = await createPayment("k5", agreementId, 3_000);
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-5a", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }),
    );
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-5b", eventType: "payment.returned", providerPaymentId: payment.providerPaymentId }),
    );

    const updated = await ctx.paymentCtx.payments.findById(payment.id);
    expect(updated?.status).toBe("returned");
    const reversalEntry = await ctx.ledgerCtx.ledgerService.findEntry(payment.id, "reversal");
    expect(reversalEntry).not.toBeNull();
  });

  it("posts a payout entry and marks payoutCompletedAt on payout.paid", async () => {
    const agreementId = "agreement-6";
    const payment = await createPayment("k6", agreementId, 4_000);
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-6a", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }),
    );
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-6b", eventType: "payout.paid", providerPaymentId: payment.providerPaymentId }),
    );

    const updated = await ctx.paymentCtx.payments.findById(payment.id);
    expect(updated?.payoutCompletedAt).not.toBeNull();
    const payoutEntry = await ctx.ledgerCtx.ledgerService.findEntry(payment.id, "payout");
    expect(payoutEntry).not.toBeNull();
  });

  it("a ledger-posting gap (no agreementId) does not fail the webhook, and reconciliation surfaces it", async () => {
    const payment = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "k7",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 1_000,
      currency: "USD",
      // no agreementId — Sprint 9 allows this; Sprint 10's ledger cannot post without one.
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    const result = await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-7", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }),
    );
    expect(result.status).toBe("processed"); // webhook still succeeds
    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
    expect(entries).toHaveLength(0); // but nothing was posted

    const found = await ctx.reconciliationService.reconcilePaymentAttempt(payment.id);
    expect(found.map((e) => e.exceptionType)).toContain("internal_posting_failure");
  });
});

describe(
  "PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md): " +
    "overpayment policy, manual off-platform payments, and deterministic agreement completion",
  () => {
    let ctx: ReturnType<typeof createFullLedgerTestContext>;

    beforeEach(async () => {
      ctx = createFullLedgerTestContext();
      ctx.paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
      ctx.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
      for (const ref of [PAYER, RECIPIENT]) {
        await ctx.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
        await ctx.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
          actingRole: "platform_owner",
          profileKind: ref.profileKind,
          profileId: ref.profileId,
          decision: "verified",
          reviewerUserId: REVIEWER_USER_ID,
          reason: null,
        });
      }
    });

    /** Seeds an agreement row at a given status, with real parties registered and a principal set. */
    async function seedAgreement(status: "first_payment_pending" | "active", principalMinorUnits: number): Promise<string> {
      const agreement = await ctx.agreementRepo.insert({
        creditorProfileKind: RECIPIENT.profileKind,
        creditorProfileId: RECIPIENT.profileId,
        debtorProfileKind: PAYER.profileKind,
        debtorProfileId: PAYER.profileId,
        currency: "USD",
        createdByUserId: PAYER_USER_ID,
      });
      await ctx.agreementRepo.updateStatus(agreement.id, status);
      ctx.paymentCtx.agreements.register(agreement.id, { creditor: RECIPIENT, debtor: PAYER });
      ctx.balanceCtx.terms.set(agreement.id, principalMinorUnits, "USD");
      return agreement.id;
    }

    it("rejects a provider-routed payment whose amount would exceed the agreement's remaining balance", async () => {
      const agreementId = await seedAgreement("first_payment_pending", 5_000);
      await expect(
        ctx.paymentCtx.paymentService.createPayment({
          idempotencyKey: "overpay-1",
          payer: PAYER,
          recipient: RECIPIENT,
          amountMinorUnits: 6_000,
          currency: "USD",
          agreementId,
          actingUserId: PAYER_USER_ID,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(/exceed the agreement's remaining balance/);
    });

    it("permits a provider-routed payment exactly equal to the remaining balance (the boundary, not merely under it)", async () => {
      const agreementId = await seedAgreement("first_payment_pending", 5_000);
      // The overpayment check runs before the provider call — reaching the sandbox provider's default
      // "pending" outcome (rather than a ValidationError) is proof the boundary amount was permitted.
      await expect(
        ctx.paymentCtx.paymentService.createPayment({
          idempotencyKey: "overpay-2",
          payer: PAYER,
          recipient: RECIPIENT,
          amountMinorUnits: 5_000,
          currency: "USD",
          agreementId,
          actingUserId: PAYER_USER_ID,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).resolves.toMatchObject({ status: "pending" });
    });

    it("records a manual off-platform payment as the debtor, posts a ledger entry immediately, and activates the agreement", async () => {
      const agreementId = await seedAgreement("first_payment_pending", 10_000);
      const record = await ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "manual-1",
        agreementId,
        amountMinorUnits: 4_000,
        actingUserId: PAYER_USER_ID,
      });
      expect(record.status).toBe("succeeded");
      expect(record.paymentMethod).toBe("manual_off_platform");
      expect(record.recordedByUserId).toBe(PAYER_USER_ID);
      expect(record.recipientConfirmedAt).toBeNull();

      const entry = await ctx.ledgerCtx.ledgerService.findEntry(record.id, "payment_cleared");
      expect(entry).not.toBeNull();

      const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreementId);
      expect(balance.amountPaidMinorUnits).toBe(4_000);
      expect(balance.settlementState).toBe("partially_paid");

      const agreement = await ctx.agreementRepo.findById(agreementId);
      expect(agreement?.status).toBe("active"); // docs/STATE_MACHINES.md §1: FirstPaymentPending -> Active on first payment cleared.
    });

    it("a manual payment that fully clears the balance completes the agreement deterministically (paid_in_full)", async () => {
      const agreementId = await seedAgreement("active", 4_000);
      const record = await ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "manual-2",
        agreementId,
        amountMinorUnits: 4_000,
        actingUserId: PAYER_USER_ID,
      });
      expect(record.status).toBe("succeeded");

      const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreementId);
      expect(balance.settlementState).toBe("paid_in_full");

      const agreement = await ctx.agreementRepo.findById(agreementId);
      expect(agreement?.status).toBe("paid_in_full");
    });

    it("a provider-routed payment.succeeded webhook also completes the agreement (not just the manual path)", async () => {
      const agreementId = await seedAgreement("active", 3_000);
      const payment = await ctx.paymentCtx.paymentService.createPayment({
        idempotencyKey: "webhook-complete-1",
        payer: PAYER,
        recipient: RECIPIENT,
        amountMinorUnits: 3_000,
        currency: "USD",
        agreementId,
        actingUserId: PAYER_USER_ID,
        ipAddress: null,
        deviceInfo: null,
      });
      const rawBody = JSON.stringify({ providerEventId: "evt-complete-1", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId });
      await ctx.webhookCtx.paymentWebhookService.receiveWebhook({
        rawBody,
        signatureHeader: ctx.paymentCtx.provider.signWebhookPayload(rawBody),
      });

      const agreement = await ctx.agreementRepo.findById(agreementId);
      expect(agreement?.status).toBe("paid_in_full");
    });

    it("rejects a manual payment that would exceed the remaining balance — the same overpayment policy as the provider-routed path", async () => {
      const agreementId = await seedAgreement("active", 1_000);
      await expect(
        ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
          idempotencyKey: "manual-overpay-1",
          agreementId,
          amountMinorUnits: 1_001,
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(/exceed the agreement's remaining balance/);
    });

    it("rejects a manual payment recorded by the creditor — only the debtor may record one", async () => {
      const agreementId = await seedAgreement("first_payment_pending", 5_000);
      await expect(
        ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
          idempotencyKey: "manual-wrong-party-1",
          agreementId,
          amountMinorUnits: 1_000,
          actingUserId: RECIPIENT_USER_ID,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("only the recipient (creditor) may confirm a manual payment, and confirming twice is idempotent", async () => {
      const agreementId = await seedAgreement("first_payment_pending", 10_000);
      const record = await ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "manual-confirm-1",
        agreementId,
        amountMinorUnits: 2_000,
        actingUserId: PAYER_USER_ID,
      });

      await expect(ctx.paymentCtx.paymentService.confirmManualPayment(record.id, PAYER_USER_ID)).rejects.toThrow(ForbiddenError);

      const confirmed = await ctx.paymentCtx.paymentService.confirmManualPayment(record.id, RECIPIENT_USER_ID);
      expect(confirmed.recipientConfirmedAt).not.toBeNull();
      // Confirmation is purely evidentiary — the payment already counted toward the balance the
      // moment it was recorded, not the moment it was confirmed.
      const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreementId);
      expect(balance.amountPaidMinorUnits).toBe(2_000);

      const reconfirmed = await ctx.paymentCtx.paymentService.confirmManualPayment(record.id, RECIPIENT_USER_ID);
      expect(reconfirmed.recipientConfirmedAt?.getTime()).toBe(confirmed.recipientConfirmedAt?.getTime());
    });

    it("the same idempotency key returns the same manual payment record without posting a second ledger entry", async () => {
      const agreementId = await seedAgreement("first_payment_pending", 10_000);
      const first = await ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "manual-idempotent-1",
        agreementId,
        amountMinorUnits: 1_000,
        actingUserId: PAYER_USER_ID,
      });
      const second = await ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "manual-idempotent-1",
        agreementId,
        amountMinorUnits: 1_000,
        actingUserId: PAYER_USER_ID,
      });
      expect(second.id).toBe(first.id);
      const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(first.id);
      expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    });
  },
);
