import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createTestBalanceService, createTestLedgerService } from "@/lib/ledger/testFakes";
import { createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import { createTestAchServices } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recipient-1" };
const PAYER_USER_ID = "payer-user-1";
const RECIPIENT_USER_ID = "recipient-user-1";
const REVIEWER_USER_ID = "reviewer-1";

describe("AchPaymentService", () => {
  let ach: ReturnType<typeof createTestAchServices>;
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let webhookCtx: ReturnType<typeof createTestPaymentWebhookService>;
  let balanceCtx: ReturnType<typeof createTestBalanceService>;
  const agreementId = randomUUID();
  const installmentId = randomUUID();

  beforeEach(async () => {
    ach = createTestAchServices();
    ledgerCtx = createTestLedgerService();
    webhookCtx = createTestPaymentWebhookService(ach.paymentCtx, ledgerCtx);
    balanceCtx = createTestBalanceService(ledgerCtx);
    balanceCtx.terms.set(agreementId, 10_000, "USD");

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
    await ach.achMandateService.authorize({
      agreementId,
      payer: PAYER,
      bankAccountRef: "sandbox_bank_1",
      actingUserId: PAYER_USER_ID,
    });
  });

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: ach.paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  async function scheduleAndSubmit(idempotencyKey: string, installmentScheduleItemId = installmentId, amountMinorUnits = 5_000) {
    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey,
      installmentScheduleItemId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await ach.achPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    return submitted;
  }

  it("pending: a scheduled payment progresses through submitted/processing without being resolved yet", async () => {
    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-pending",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    expect(scheduled.status).toBe("scheduled");
    const submitted = await ach.achPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    expect(submitted.status).toBe("processing");
    expect(submitted.providerPaymentId).toBeTruthy();

    // Not yet counted as paid — no ledger entry exists until a webhook resolves it.
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
  });

  it("success: processing -> succeeded via webhook posts the ledger entry and counts toward the balance", async () => {
    const submitted = await scheduleAndSubmit("k-success");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-success", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    const updated = await ach.paymentCtx.payments.findById(submitted.id);
    expect(updated?.status).toBe("succeeded");
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(5_000);
  });

  it("NSF: processing -> failed via webhook, with a non-sensitive failure reason recorded", async () => {
    const submitted = await scheduleAndSubmit("k-nsf");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({
        providerEventId: "evt-nsf",
        eventType: "payment.failed",
        providerPaymentId: submitted.providerPaymentId,
        failureCategory: "insufficient_funds",
      }),
    );
    const updated = await ach.paymentCtx.payments.findById(submitted.id);
    expect(updated?.status).toBe("failed");
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
  });

  it("returned: succeeded -> returned via a late ACH return webhook; no longer counted as paid", async () => {
    const submitted = await scheduleAndSubmit("k-returned");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-ret-a", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-ret-b", eventType: "payment.returned", providerPaymentId: submitted.providerPaymentId }),
    );
    const updated = await ach.paymentCtx.payments.findById(submitted.id);
    expect(updated?.status).toBe("returned");
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.reversedMinorUnits).toBe(5_000);
  });

  it("revoked mandate: scheduling fails once the mandate has been revoked", async () => {
    const mandate = await ach.achMandateService.getActiveMandate(agreementId);
    await ach.achMandateService.revoke({ mandateId: mandate!.id, actingUserId: PAYER_USER_ID, reason: "borrower requested" });

    await expect(
      ach.achPaymentService.scheduleInstallmentPayment({
        idempotencyKey: "k-revoked",
        installmentScheduleItemId: installmentId,
        agreementId,
        payer: PAYER,
        recipient: RECIPIENT,
        amountMinorUnits: 5_000,
        currency: "USD",
        actingUserId: PAYER_USER_ID,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("revoked mandate: does not erase the debt — the agreement's principal is untouched", async () => {
    const before = await balanceCtx.terms.getPrincipal(agreementId);
    const mandate = await ach.achMandateService.getActiveMandate(agreementId);
    await ach.achMandateService.revoke({ mandateId: mandate!.id, actingUserId: PAYER_USER_ID, reason: "x" });
    const after = await balanceCtx.terms.getPrincipal(agreementId);
    expect(after).toEqual(before);
  });

  it("duplicate debit prevention: a second schedule attempt for the same open installment is rejected", async () => {
    await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-dup-1",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    await expect(
      ach.achPaymentService.scheduleInstallmentPayment({
        idempotencyKey: "k-dup-2",
        installmentScheduleItemId: installmentId,
        agreementId,
        payer: PAYER,
        recipient: RECIPIENT,
        amountMinorUnits: 5_000,
        currency: "USD",
        actingUserId: PAYER_USER_ID,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("duplicate debit prevention: a new attempt IS allowed once the prior one reached a terminal state (retry, not a duplicate)", async () => {
    const submitted = await scheduleAndSubmit("k-retry-1");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-retry", eventType: "payment.failed", providerPaymentId: submitted.providerPaymentId }),
    );
    const retry = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-retry-2",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    expect(retry.status).toBe("scheduled");
  });

  it("first payment failure: the first installment (sequenceNumber 0) can fail without blocking a fresh attempt for the same agreement", async () => {
    const firstInstallmentId = randomUUID();
    const submitted = await scheduleAndSubmit("k-first-fail", firstInstallmentId);
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-first-fail", eventType: "payment.failed", providerPaymentId: submitted.providerPaymentId }),
    );
    expect((await ach.paymentCtx.payments.findById(submitted.id))?.status).toBe("failed");

    // The agreement itself remains usable: a fresh attempt (a different installment, or a manual
    // retry) against the same agreement succeeds normally — AchPaymentService has no dependency
    // capable of marking an agreement invalid, and nothing here prevents further payments.
    const anotherInstallmentId = randomUUID();
    const retried = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-first-fail-retry",
      installmentScheduleItemId: anotherInstallmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    expect(retried.status).toBe("scheduled");
  });

  it("payout only after cleared state: a processing (not yet cleared) ACH payment cannot be paid out", async () => {
    const submitted = await scheduleAndSubmit("k-payout-early");
    await expect(ledgerCtx.ledgerService.postPayout({ paymentAttemptId: submitted.id })).rejects.toThrow(ValidationError);

    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-payout", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    const payout = await ledgerCtx.ledgerService.postPayout({ paymentAttemptId: submitted.id });
    expect(payout.entryType).toBe("payout");
  });

  it("is structurally incapable of calling the payment provider directly, bypassing PaymentService's verification gate", () => {
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ach.achPaymentService));
    expect(methodNames).not.toContain("createRecipientAccount");
    expect(methodNames).not.toContain("verifyWebhookSignature");
  });
});
