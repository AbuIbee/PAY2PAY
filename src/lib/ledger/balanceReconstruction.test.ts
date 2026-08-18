import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createFullLedgerTestContext } from "./integrationTestFakes";

const PAYER = { profileKind: "personal" as const, profileId: "recon-payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recon-recipient-1" };
const PAYER_USER_ID = "recon-payer-user-1";
const RECIPIENT_USER_ID = "recon-recipient-user-1";
const STRANGER_USER_ID = "recon-stranger-user-1";
const REVIEWER_USER_ID = "recon-reviewer-1";

/**
 * PRSprint 19 (docs/prsprints/PRSPRINT_19_AUTHORITATIVE_LEDGER_TRANSACTION_INTEGRITY.md): the
 * required reconciliation-scenario test matrix, proving in each case that
 * `BalanceService.getAgreementBalance` — see docs/PAYMENT_ARCHITECTURE.md §14.1's "balance source of
 * truth" documentation — is reconstructable entirely from `agreement_version.terms` +
 * `ledger_journal_entry`/`ledger_posting`, with no other stored or cached balance anywhere in the
 * system. Ten scenarios, matching the Phase 5 kickoff's own required list exactly: new obligation,
 * one payment, partial payment, multiple payments, completion, reversal/failure, duplicate event,
 * concurrent event, admin correction, attempted unauthorized mutation.
 */
describe("PRSprint 19: balance reconstruction from authoritative ledger records alone", () => {
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

  async function clearPayment(idempotencyKey: string, agreementId: string, amountMinorUnits: number, providerEventId: string) {
    const payment = await ctx.paymentCtx.paymentService.createPayment({
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
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }),
    );
    return payment;
  }

  it("1. new obligation: an agreement with no payments yet reconstructs to unpaid, remaining = full principal", async () => {
    ctx.balanceCtx.terms.set("agreement-new", 10_000, "USD");
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-new");
    expect(balance).toMatchObject({ amountPaidMinorUnits: 0, remainingBalanceMinorUnits: 10_000, settlementState: "unpaid" });
  });

  it("2. one payment: a single cleared payment reconstructs to exactly that amount paid", async () => {
    ctx.balanceCtx.terms.set("agreement-one", 10_000, "USD");
    await clearPayment("recon-one-1", "agreement-one", 4_000, "recon-evt-one-1");
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-one");
    expect(balance).toMatchObject({ amountPaidMinorUnits: 4_000, remainingBalanceMinorUnits: 6_000, settlementState: "partially_paid" });
  });

  it("3. partial payment: an amount less than the principal reconstructs to 'partially_paid', never rounding or guessing the remainder", async () => {
    ctx.balanceCtx.terms.set("agreement-partial", 9_999, "USD"); // deliberately not evenly divisible, per this project's "nothing lost or invented" precedent.
    await clearPayment("recon-partial-1", "agreement-partial", 3_333, "recon-evt-partial-1");
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-partial");
    expect(balance.remainingBalanceMinorUnits).toBe(6_666);
    expect(balance.settlementState).toBe("partially_paid");
  });

  it("4. multiple payments: sequential cleared payments sum exactly, independent of how many there were", async () => {
    ctx.balanceCtx.terms.set("agreement-multi", 10_000, "USD");
    await clearPayment("recon-multi-1", "agreement-multi", 2_000, "recon-evt-multi-1");
    await clearPayment("recon-multi-2", "agreement-multi", 3_000, "recon-evt-multi-2");
    await clearPayment("recon-multi-3", "agreement-multi", 1_500, "recon-evt-multi-3");
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-multi");
    expect(balance.amountPaidMinorUnits).toBe(6_500);
    expect(balance.remainingBalanceMinorUnits).toBe(3_500);
  });

  it("5. completion: payments summing to exactly the principal reconstruct to 'paid_in_full', not 'overpaid' or 'partially_paid'", async () => {
    ctx.balanceCtx.terms.set("agreement-complete", 5_000, "USD");
    await clearPayment("recon-complete-1", "agreement-complete", 2_000, "recon-evt-complete-1");
    await clearPayment("recon-complete-2", "agreement-complete", 3_000, "recon-evt-complete-2");
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-complete");
    expect(balance).toMatchObject({ amountPaidMinorUnits: 5_000, remainingBalanceMinorUnits: 0, settlementState: "paid_in_full" });
  });

  it("6a. reversal: a cleared-then-refunded payment is excluded from amountPaid and counted as reversed, not deleted from history", async () => {
    ctx.balanceCtx.terms.set("agreement-reversal", 5_000, "USD");
    const payment = await clearPayment("recon-reversal-1", "agreement-reversal", 5_000, "recon-evt-reversal-1a");
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-evt-reversal-1b", eventType: "payment.refunded", providerPaymentId: payment.providerPaymentId }),
    );
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-reversal");
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.reversedMinorUnits).toBe(5_000);
    // History preserved, not deleted: both the original clear and the reversal remain as separate rows.
    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
    expect(entries.map((e) => e.entryType).sort()).toEqual(["payment_cleared", "refund"]);
  });

  it("6b. failure: a failed payment posts no ledger entry at all and does not affect the reconstructed balance", async () => {
    ctx.balanceCtx.terms.set("agreement-failure", 5_000, "USD");
    const payment = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "recon-failure-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: "agreement-failure",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-evt-failure-1", eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }),
    );
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-failure");
    expect(balance).toMatchObject({ amountPaidMinorUnits: 0, remainingBalanceMinorUnits: 5_000, settlementState: "unpaid" });
  });

  it("7. duplicate event: a replayed webhook is rejected as a duplicate and never double-counts in the reconstructed balance", async () => {
    ctx.balanceCtx.terms.set("agreement-dup", 5_000, "USD");
    const payment = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "recon-dup-1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 2_000,
      currency: "USD",
      agreementId: "agreement-dup",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    const event = signedWebhook({ providerEventId: "recon-evt-dup-1", eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId });
    const first = await ctx.webhookCtx.paymentWebhookService.receiveWebhook(event);
    const second = await ctx.webhookCtx.paymentWebhookService.receiveWebhook(event);
    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-dup");
    expect(balance.amountPaidMinorUnits).toBe(2_000);
  });

  it("8. concurrent event: the reconstructed balance is identical regardless of which order two independent payments' events are processed in", async () => {
    ctx.balanceCtx.terms.set("agreement-order-a", 10_000, "USD");
    ctx.balanceCtx.terms.set("agreement-order-b", 10_000, "USD");

    // Order A: payment 1 then payment 2.
    await clearPayment("recon-order-a1", "agreement-order-a", 3_000, "recon-evt-order-a1");
    await clearPayment("recon-order-a2", "agreement-order-a", 4_000, "recon-evt-order-a2");

    // Order B: the identical two amounts, payment 2 then payment 1 (reversed order).
    const paymentB2 = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "recon-order-b2",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 4_000,
      currency: "USD",
      agreementId: "agreement-order-b",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    const paymentB1 = await ctx.paymentCtx.paymentService.createPayment({
      idempotencyKey: "recon-order-b1",
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 3_000,
      currency: "USD",
      agreementId: "agreement-order-b",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-evt-order-b2", eventType: "payment.succeeded", providerPaymentId: paymentB2.providerPaymentId }),
    );
    await ctx.webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-evt-order-b1", eventType: "payment.succeeded", providerPaymentId: paymentB1.providerPaymentId }),
    );

    const balanceA = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-order-a");
    const balanceB = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-order-b");
    expect(balanceA.amountPaidMinorUnits).toBe(balanceB.amountPaidMinorUnits);
    expect(balanceA.remainingBalanceMinorUnits).toBe(balanceB.remainingBalanceMinorUnits);
  });

  it("9. admin correction: an admin_adjustment entry is ledger-visible but never changes the debtor's reconstructed balance (it corrects internal bookkeeping, not the debtor's obligation)", async () => {
    ctx.balanceCtx.terms.set("agreement-admin", 5_000, "USD");
    const payment = await clearPayment("recon-admin-1", "agreement-admin", 5_000, "recon-evt-admin-1");
    const before = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-admin");

    const adjustment = await ctx.ledgerCtx.ledgerService.postAdminAdjustment({
      paymentAttemptId: payment.id,
      agreementId: "agreement-admin",
      currency: "USD",
      targetAccountType: "platform_fee_revenue",
      direction: "credit",
      amountMinorUnits: 100,
      reason: "Correcting a misallocated platform fee — internal bookkeeping only.",
      actingUserId: REVIEWER_USER_ID,
    });
    expect(adjustment.entryType).toBe("admin_adjustment");

    const after = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-admin");
    expect(after.amountPaidMinorUnits).toBe(before.amountPaidMinorUnits);
    expect(after.remainingBalanceMinorUnits).toBe(before.remainingBalanceMinorUnits);
    // But the correction itself is fully traceable in the ledger — never silently applied.
    const entries = await ctx.ledgerCtx.ledgerService.listEntriesForPaymentAttempt(payment.id);
    expect(entries.map((e) => e.entryType)).toContain("admin_adjustment");
  });

  it("10. attempted unauthorized mutation: a stranger cannot refund or cancel someone else's payment, and the reconstructed balance is unaffected by the attempt", async () => {
    ctx.balanceCtx.terms.set("agreement-unauthorized", 5_000, "USD");
    const payment = await clearPayment("recon-unauth-1", "agreement-unauthorized", 5_000, "recon-evt-unauth-1");

    await expect(ctx.paymentCtx.paymentService.refundPayment(payment.id, STRANGER_USER_ID)).rejects.toThrow(ForbiddenError);
    // A stranger fails the payer-or-recipient authorization gate before ever reaching the
    // "only pending/scheduled" status check — ForbiddenError, not ValidationError.
    await expect(ctx.paymentCtx.paymentService.cancelPayment(payment.id, STRANGER_USER_ID)).rejects.toThrow(ForbiddenError);

    const balance = await ctx.balanceCtx.balanceService.getAgreementBalance("agreement-unauthorized");
    expect(balance.amountPaidMinorUnits).toBe(5_000);
    expect(balance.settlementState).toBe("paid_in_full");
  });
});
