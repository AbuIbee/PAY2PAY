import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createFullLedgerTestContext } from "./integrationTestFakes";

const PAYER = { profileKind: "personal" as const, profileId: "conc-payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "conc-recipient-1" };
const PAYER_USER_ID = "conc-payer-user-1";
const RECIPIENT_USER_ID = "conc-recipient-user-1";
const REVIEWER_USER_ID = "conc-reviewer-1";

/**
 * PRSprint 20 (docs/prsprints/PRSPRINT_20_IDEMPOTENCY_CONCURRENCY_FINANCIAL_STATE_SAFETY.md): the
 * required adversarial/race test matrix, using genuine `Promise.all`-based concurrent interleaving
 * (not serial double-invocation — see docs/prsprints/PHASE_5_PREFLIGHT_FINDINGS.md §4/§9 for why this
 * is meaningful against this codebase's in-memory test fakes: every fake in this suite either checks
 * synchronously-with-no-await-before-reserve, like a real DB unique constraint, or uses `KeyedMutex`
 * to model a real DB row lock — see `InMemoryPaymentWebhookEventRepository`/
 * `InMemoryLedgerJournalEntryRepository`/`InMemoryAtomicManualPaymentPoster`'s own doc comments).
 *
 * Eleven scenarios, matching the Phase 5 kickoff's own required list. Four are already covered by
 * existing, real (if not `Promise.all`-shaped) tests and are not duplicated here — referenced instead:
 * - "duplicate provider transaction ID": src/lib/ledger/reconciliationService.test.ts's
 *   "detects duplicate_transaction across two payment_attempts sharing a provider_payment_id".
 * - "retry-after-timeout" / "retry-after-success-before-ack":
 *   src/lib/failedPayments/paymentRetryService.test.ts's "manual success cancels retry".
 */
describe("PRSprint 20: concurrency and idempotency — genuine adversarial races", () => {
  let ctx: ReturnType<typeof createFullLedgerTestContext>;

  beforeEach(async () => {
    ctx = createFullLedgerTestContext();
    ctx.paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    ctx.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    for (const ref of [PAYER, RECIPIENT]) {
      await ctx.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await ctx.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
  });

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: ctx.paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  it("1/2. duplicate payment submission with a reused idempotency key: two truly concurrent createPayment calls create exactly one payment_attempt", async () => {
    const input = {
      idempotencyKey: "conc-dup-submit-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: null,
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    };
    const [a, b] = await Promise.all([ctx.paymentCtx.paymentService.createPayment(input), ctx.paymentCtx.paymentService.createPayment(input)]);
    expect(a.id).toBe(b.id);
    const all = await ctx.paymentCtx.payments.listAll();
    expect(all.filter((p) => p.idempotencyKey === "conc-dup-submit-1")).toHaveLength(1);
  });

  it("3. duplicate webhook: two truly concurrent deliveries of the identical event process exactly once and post exactly one ledger entry", async () => {
    ctx.balanceCtx.terms.set("agreement-conc-webhook", 5_000, "USD");
    const payment = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "conc-webhook-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: "agreement-conc-webhook",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    const event = signedWebhook({ providerEventId: "conc-evt-webhook-1", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId });

    const [first, second] = await Promise.all([
      ctx.webhookCtx.paymentWebhookService.receiveWebhook(event),
      ctx.webhookCtx.paymentWebhookService.receiveWebhook(event),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["duplicate", "processed"]);

    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-conc-webhook");
    expect(balance.amountPaidMinorUnits).toBe(5_000); // not 10,000 — never double-counted.
  });

  it("5. concurrent partials: two truly concurrent manual payments, each individually within budget but combined overpaying, result in exactly one accepted and the total never exceeding the principal", async () => {
    const agreement = await ctx.agreementRepo.insert({
      creditorProfileKind: RECIPIENT.profileKind,
      creditorProfileId: RECIPIENT.profileId,
      debtorProfileKind: PAYER.profileKind,
      debtorProfileId: PAYER.profileId,
      currency: "USD",
      createdByUserId: PAYER_USER_ID,
    });
    await ctx.agreementRepo.updateStatus(agreement.id, "first_payment_pending");
    ctx.paymentCtx.agreements.register(agreement.id, { creditor: RECIPIENT, debtor: PAYER });
    ctx.balanceCtx.terms.set(agreement.id, 100_00, "USD"); // $100.00 principal.

    // Two concurrent manual payments of $60 each — each individually well within the $100 remaining
    // balance at the moment both start, but $60 + $60 = $120 > $100 combined.
    const results = await Promise.allSettled([
      ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "conc-partial-a",
        agreementId: agreement.id,
        amountMinorUnits: 60_00,
        actingUserId: PAYER_USER_ID,
      }),
      ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "conc-partial-b",
        agreementId: agreement.id,
        amountMinorUnits: 60_00,
        actingUserId: PAYER_USER_ID,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1); // exactly one wins the race.
    expect(rejected).toHaveLength(1); // the other is correctly rejected, not silently double-applied.
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(ValidationError);
    }

    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreement.id);
    expect(balance.amountPaidMinorUnits).toBe(60_00); // never 120_00 — the overpayment race is closed.
    expect(balance.amountPaidMinorUnits).toBeLessThanOrEqual(100_00);
  });

  it("6. concurrent finals: two truly concurrent manual payments that would each individually complete the agreement — only one actually clears it, deterministically", async () => {
    const agreement = await ctx.agreementRepo.insert({
      creditorProfileKind: RECIPIENT.profileKind,
      creditorProfileId: RECIPIENT.profileId,
      debtorProfileKind: PAYER.profileKind,
      debtorProfileId: PAYER.profileId,
      currency: "USD",
      createdByUserId: PAYER_USER_ID,
    });
    await ctx.agreementRepo.updateStatus(agreement.id, "active");
    ctx.paymentCtx.agreements.register(agreement.id, { creditor: RECIPIENT, debtor: PAYER });
    ctx.balanceCtx.terms.set(agreement.id, 50_00, "USD");

    const results = await Promise.allSettled([
      ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "conc-final-a",
        agreementId: agreement.id,
        amountMinorUnits: 50_00,
        actingUserId: PAYER_USER_ID,
      }),
      ctx.paymentCtx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: "conc-final-b",
        agreementId: agreement.id,
        amountMinorUnits: 50_00,
        actingUserId: PAYER_USER_ID,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance(agreement.id);
    expect(balance.settlementState).toBe("paid_in_full");
    expect(balance.amountPaidMinorUnits).toBe(50_00); // never 100_00.
    const updated = await ctx.agreementRepo.findById(agreement.id);
    expect(updated?.status).toBe("paid_in_full");
  });

  it("9. out-of-order status transition: a refund/dispute webhook arriving before the payment has ever cleared is rejected cleanly, not silently applied against nothing", async () => {
    const payment = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "conc-outoforder-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 3_000,
      currency: "USD",
      agreementId: null,
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    // "payment.refunded" arrives before any "payment.succeeded" — LedgerService.reversePayment
    // requires a prior payment_cleared entry to reverse; postLedgerEntry catches and logs rather than
    // corrupting state, and the payment_attempt's own status is still updated to "refunded" per the
    // webhook's own status mapping (docs/PAYMENT_ARCHITECTURE.md's "webhook status is authoritative
    // for payment_attempt.status regardless of ledger-posting outcome").
    const result = await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "conc-evt-outoforder-1", eventType: "payment.refunded", providerPaymentId: payment.providerPaymentId }),
    );
    expect(result.status).toBe("processed"); // the webhook itself is still accepted and recorded once.
    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
    expect(entries).toHaveLength(0); // but nothing was posted — no phantom reversal of a non-existent clear.
  });

  it("10. mutation after terminal state: cancelling an already-refunded payment is rejected, and refunding an already-refunded payment is rejected", async () => {
    ctx.balanceCtx.terms.set("agreement-terminal", 5_000, "USD");
    const payment = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "conc-terminal-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: "agreement-terminal",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    // The sandbox provider's own internal simulated record starts "pending" regardless of what the
    // webhook later does to payment_attempt.status (the two are deliberately not auto-synced — see
    // simulateSettlement's doc comment); PaymentService.refundPayment calls the real provider's own
    // refundPayment, which requires ITS record to say "succeeded" too.
    ctx.paymentCtx.provider.simulateSettlement(payment.providerPaymentId!, "succeeded");
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "conc-evt-terminal-1", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }),
    );
    const refunded = await ctx.paymentCtx.paymentService.refundPayment(payment.id, RECIPIENT_USER_ID);
    expect(refunded.status).toBe("refunded");

    await expect(ctx.paymentCtx.paymentService.cancelPayment(payment.id, PAYER_USER_ID)).rejects.toThrow(ValidationError);
    await expect(ctx.paymentCtx.paymentService.refundPayment(payment.id, RECIPIENT_USER_ID)).rejects.toThrow(ValidationError);
  });

  it("11. duplicate ledger posting: two truly concurrent LedgerService.postPaymentCleared calls for the same payment_attempt post exactly one journal entry", async () => {
    const paymentAttemptId = "conc-ledger-post-1";
    const input = { paymentAttemptId, agreementId: "agreement-conc-ledger", currency: "USD", grossAmountMinorUnits: 4_000 };
    const [entryA, entryB] = await Promise.all([
      ctx.ledgerCtx.ledgerService.postPaymentCleared(input),
      ctx.ledgerCtx.ledgerService.postPaymentCleared(input),
    ]);
    expect(entryA.id).toBe(entryB.id); // the racing caller gets back the winner's entry, not an error or a second row.
    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(paymentAttemptId);
    expect(entries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("bonus: a stranger's concurrent refund attempts alongside the recipient's legitimate one never succeed, regardless of race timing", async () => {
    ctx.balanceCtx.terms.set("agreement-stranger-race", 5_000, "USD");
    const strangerUserId = "conc-stranger-1";
    const payment = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "conc-stranger-race-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: "agreement-stranger-race",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    ctx.paymentCtx.provider.simulateSettlement(payment.providerPaymentId!, "succeeded");
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "conc-evt-stranger-race-1", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }),
    );

    const results = await Promise.allSettled([
      ctx.paymentCtx.paymentService.refundPayment(payment.id, strangerUserId),
      ctx.paymentCtx.paymentService.refundPayment(payment.id, RECIPIENT_USER_ID),
    ]);
    const strangerResult = results[0];
    expect(strangerResult.status).toBe("rejected");
    if (strangerResult.status === "rejected") expect(strangerResult.reason).toBeInstanceOf(ForbiddenError);
  });
});
