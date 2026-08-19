import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryReconciliationExceptionRepository } from "@/lib/ledger/testFakes";
import { createTestBalanceService, createTestLedgerService } from "@/lib/ledger/testFakes";
import { ReconciliationService } from "@/lib/ledger/reconciliationService";
import { createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import { createTestAchServices } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "recon-ach-payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recon-ach-recipient-1" };
const PAYER_USER_ID = "recon-ach-payer-user-1";
const RECIPIENT_USER_ID = "recon-ach-recipient-user-1";
const REVIEWER_USER_ID = "recon-ach-reviewer-1";

/**
 * PRSprint 23 (docs/prsprints/PRSPRINT_23_ACH_BANK_LINKING_RECONCILIATION.md): ACH payments already
 * flow through the exact same PaymentService/PaymentWebhookService/LedgerService/ReconciliationService
 * infrastructure Phase 5 hardened generically — this file exists to prove that inherited coverage
 * concretely for the ACH-specific path (through AchMandateService/AchPaymentService, not
 * PaymentService.createPayment directly), rather than merely assuming it transfers.
 */
describe("PRSprint 23: ACH-specific reconciliation", () => {
  let ach: ReturnType<typeof createTestAchServices>;
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let webhookCtx: ReturnType<typeof createTestPaymentWebhookService>;
  let balanceCtx: ReturnType<typeof createTestBalanceService>;
  let reconciliationService: ReconciliationService;
  const agreementId = randomUUID();
  const installmentId = randomUUID();

  beforeEach(async () => {
    ach = createTestAchServices();
    ledgerCtx = createTestLedgerService();
    webhookCtx = createTestPaymentWebhookService(ach.paymentCtx, ledgerCtx);
    balanceCtx = createTestBalanceService(ledgerCtx);
    balanceCtx.terms.set(agreementId, 10_000, "USD");
    reconciliationService = new ReconciliationService({
      payments: ach.paymentCtx.payments,
      webhookEvents: webhookCtx.events,
      provider: ach.paymentCtx.provider,
      ledger: ledgerCtx.ledgerService,
      exceptions: new InMemoryReconciliationExceptionRepository(),
    });

    ach.paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    ach.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    for (const ref of [PAYER, RECIPIENT]) {
      await ach.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await ach.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
    await ach.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "sandbox_bank_1", actingUserId: PAYER_USER_ID });
  });

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: ach.paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  it("a normal ACH lifecycle (schedule -> submit -> succeed) raises zero reconciliation exceptions — no false positives", async () => {
    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "recon-ach-normal-1",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await ach.achPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    // The sandbox provider's own internal simulated record starts "pending" regardless of what the
    // webhook later does to payment_attempt.status (the two are deliberately not auto-synced — see
    // simulateSettlement's doc comment); reconciliation's own status_mismatch check compares against
    // the provider's ACTUAL (sandbox) state, so this keeps the two in sync the same way a real
    // provider webhook would.
    ach.paymentCtx.provider.simulateSettlement(submitted.providerPaymentId!, "succeeded");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-ach-normal-evt-1", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );

    const found = await reconciliationService.reconcilePaymentAttempt(submitted.id);
    expect(found).toHaveLength(0);
  });

  it("a normal ACH return (succeeded -> returned via a late-return webhook, with the correct reversal posted) also raises zero reconciliation exceptions", async () => {
    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "recon-ach-return-1",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await ach.achPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-ach-return-evt-a", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-ach-return-evt-b", eventType: "payment.returned", providerPaymentId: submitted.providerPaymentId }),
    );

    const found = await reconciliationService.reconcilePaymentAttempt(submitted.id);
    expect(found).toHaveLength(0);
    // Item 106: "ACH returns must restore the correct balance" — confirmed via the actual balance, not just the absence of an exception.
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.remainingBalanceMinorUnits).toBe(10_000);
  });

  it("detects reversal_refund_mismatch when an ACH return webhook posts the reversal but the payment_attempt's own status is (hypothetically) never updated to match", async () => {
    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "recon-ach-drift-1",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await ach.achPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "recon-ach-drift-evt-a", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    // Post the reversal directly against the ledger without going through the webhook's own status
    // update — models exactly the drift item 37 requires detecting ("local pending/provider success",
    // generalized here to "ledger says reversed, payment_attempt status doesn't agree").
    await ledgerCtx.ledgerService.reversePayment({ paymentAttemptId: submitted.id, entryType: "reversal", reason: "Simulated drift for this test." });

    const found = await reconciliationService.reconcilePaymentAttempt(submitted.id);
    expect(found.map((e) => e.exceptionType)).toContain("reversal_refund_mismatch");
  });
});
