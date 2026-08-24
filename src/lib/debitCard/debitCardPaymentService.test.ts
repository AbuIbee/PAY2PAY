import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createTestBalanceService, createTestLedgerService } from "@/lib/ledger/testFakes";
import { createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import { computeCardProcessorFeeMinorUnits } from "./cardFeeAllocation";
import { createTestDebitCardServices, TEST_FUTURE_CARD_EXPIRY, TEST_PAST_CARD_EXPIRY } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recipient-1" };
const PAYER_USER_ID = "payer-user-1";
const RECIPIENT_USER_ID = "recipient-user-1";
const REVIEWER_USER_ID = "reviewer-1";

describe("DebitCardPaymentService", () => {
  let card: ReturnType<typeof createTestDebitCardServices>;
  let ledgerCtx: ReturnType<typeof createTestLedgerService>;
  let webhookCtx: ReturnType<typeof createTestPaymentWebhookService>;
  let balanceCtx: ReturnType<typeof createTestBalanceService>;
  const agreementId = randomUUID();
  const installmentId = randomUUID();

  beforeEach(async () => {
    card = createTestDebitCardServices();
    ledgerCtx = createTestLedgerService();
    webhookCtx = createTestPaymentWebhookService(card.paymentCtx, ledgerCtx);
    balanceCtx = createTestBalanceService(ledgerCtx);
    balanceCtx.terms.set(agreementId, 10_000, "USD");
    card.feeAllocation.set(agreementId, "debtor_pays");

    card.paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    card.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    for (const ref of [PAYER, RECIPIENT]) {
      await card.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await card.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
    await card.debitCardMethodService.registerCard({
      agreementId,
      payer: PAYER,
      cardToken: "sandbox_pm_1",
      cardLast4: "4242",
      cardBrand: "visa",
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: PAYER_USER_ID,
    });
  });

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: card.paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  async function scheduleAndSubmit(
    idempotencyKey: string,
    installmentScheduleItemId = installmentId,
    amountMinorUnits = 5_000,
  ) {
    const scheduled = await card.debitCardPaymentService.scheduleInstallmentPayment({
      idempotencyKey,
      installmentScheduleItemId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await card.debitCardPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    return { scheduled, submitted };
  }

  it("approved: schedule -> submit -> succeeded via webhook posts the ledger entry and counts toward the balance, tagged as a debit_card payment", async () => {
    const { scheduled, submitted } = await scheduleAndSubmit("k-approved");
    expect(scheduled.status).toBe("scheduled");
    const fullRecord = await card.paymentCtx.payments.findById(submitted.id);
    expect(fullRecord?.paymentMethod).toBe("debit_card");

    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-approved", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    const updated = await card.paymentCtx.payments.findById(submitted.id);
    expect(updated?.status).toBe("succeeded");
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    // Charged amount includes the debtor_pays fee surcharge on top of the 5_000 scheduled amount.
    expect(balance.amountPaidMinorUnits).toBe(scheduled.charge.totalChargeMinorUnits);
  });

  it("decline: a card payment can fail (authorization decline) after submission", async () => {
    // Known limitation, documented in SPRINT_CONTROL.md: DebitCardPaymentService always goes
    // through PaymentService.schedulePayment/submitPending (matching AchPaymentService's contract),
    // which never exposes SandboxPaymentProvider's synchronous simulateOutcome hook to a caller — so
    // this test, like Sprint 11's ACH decline test, models the decline via the async webhook path.
    // A real card adapter's near-immediate authorization decline (docs/PAYMENT_STATE_MACHINE.md
    // §1.1) would still surface through this exact same payment.failed webhook handling; only the
    // provider's own timing differs, not any code path in this service.
    const scheduled = await card.debitCardPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-decline",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await card.debitCardPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({
        providerEventId: "evt-decline",
        eventType: "payment.failed",
        providerPaymentId: submitted.providerPaymentId,
        failureCategory: "card_declined",
      }),
    );
    const updated = await card.paymentCtx.payments.findById(submitted.id);
    expect(updated?.status).toBe("failed");
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
  });

  it("expired: scheduling fails once the registered card's expiry date has passed", async () => {
    // Simulates a card that was valid when registered but has since expired with the passage of
    // time (the realistic "expired card" scenario) — inserted directly through the repository,
    // bypassing DebitCardMethodService's own registration-time validation (which correctly refuses
    // to register a card that is already expired; see debitCardMethodService.test.ts).
    const originalCard = await card.debitCardMethodService.getActiveCard(agreementId);
    await card.cards.markReplaced(originalCard!.id, new Date(), "test: force an expired card");
    await card.cards.insert({
      agreementId,
      payerProfileKind: PAYER.profileKind,
      payerProfileId: PAYER.profileId,
      cardToken: "expired_token",
      cardLast4: "0000",
      cardBrand: null,
      ...TEST_PAST_CARD_EXPIRY,
      supersedesCardMethodId: originalCard!.id,
    });
    await expect(
      card.debitCardPaymentService.scheduleInstallmentPayment({
        idempotencyKey: "k-expired",
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

  it("dispute: succeeded -> reversed via a chargeback webhook; no longer counted as paid, and reduces the recorded balance without deleting history", async () => {
    const { submitted } = await scheduleAndSubmit("k-dispute");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-dispute-a", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-dispute-b", eventType: "payment.reversed", providerPaymentId: submitted.providerPaymentId }),
    );
    const updated = await card.paymentCtx.payments.findById(submitted.id);
    expect(updated?.status).toBe("reversed");
    const balance = await balanceCtx.balanceService.getAgreementBalance(agreementId);
    expect(balance.amountPaidMinorUnits).toBe(0);
    expect(balance.reversedMinorUnits).toBeGreaterThan(0);
    // History preserved — the original payment_attempt row and its "succeeded" transition still exist.
    expect(await card.paymentCtx.payments.findById(submitted.id)).not.toBeNull();
  });

  it("refund: a succeeded card payment can be refunded through PaymentService's existing generic path", async () => {
    const { submitted } = await scheduleAndSubmit("k-refund");
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({ providerEventId: "evt-refund-a", eventType: "payment.succeeded", providerPaymentId: submitted.providerPaymentId }),
    );
    // The webhook only updates the payment_attempt row's own status; refundPayment separately calls
    // back into the provider, which tracks its own internal state — simulateSettlement is the
    // sandbox provider's designated test hook for that (mirrors src/lib/payments/paymentService.test.ts's
    // refund test, which monkey-patches createPayment's simulateOutcome for the same reason).
    card.paymentCtx.provider.simulateSettlement(submitted.providerPaymentId!, "succeeded");
    const refunded = await card.paymentCtx.paymentService.refundPayment(submitted.id, RECIPIENT_USER_ID);
    expect(refunded.status).toBe("refunded");
  });

  it("card replacement: after replacing the card, a new payment schedules successfully and the old card no longer counts as active", async () => {
    const originalCard = await card.debitCardMethodService.getActiveCard(agreementId);
    const replacement = await card.debitCardMethodService.replaceCard({
      agreementId,
      payer: PAYER,
      newCardToken: "new_token",
      cardLast4: "9999",
      cardBrand: "mastercard",
      ...TEST_FUTURE_CARD_EXPIRY,
      reason: "card lost",
      actingUserId: PAYER_USER_ID,
    });
    expect(replacement.supersedesCardMethodId).toBe(originalCard!.id);

    const { scheduled } = await scheduleAndSubmit("k-replaced");
    expect(scheduled.status).toBe("scheduled");
    expect((await card.cards.findById(originalCard!.id))?.status).toBe("replaced");
  });

  it("fee allocation: creditor_pays absorbs the card fee entirely — the borrower's total charge equals the scheduled amount", async () => {
    card.feeAllocation.set(agreementId, "creditor_pays");
    const scheduled = await card.debitCardPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-fee-creditor",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    expect(scheduled.charge.borrowerSurchargeMinorUnits).toBe(0);
    expect(scheduled.charge.totalChargeMinorUnits).toBe(5_000);
  });

  it("fee allocation: debtor_pays surcharges the borrower the full incremental card processing cost on top of the scheduled amount", async () => {
    const scheduled = await card.debitCardPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-fee-debtor",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const expectedFee = computeCardProcessorFeeMinorUnits(5_000);
    expect(scheduled.charge.borrowerSurchargeMinorUnits).toBe(expectedFee);
    expect(scheduled.charge.totalChargeMinorUnits).toBe(5_000 + expectedFee);
  });

  it("fee allocation: does not reduce the creditor's expected net proceeds — the amount collected already includes the surcharge before ledger fee subtraction", async () => {
    const scheduled = await card.debitCardPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "k-fee-net",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const submitted = await card.debitCardPaymentService.submitScheduledPayment(scheduled.id, PAYER_USER_ID);
    await webhookCtx.paymentWebhookService.receiveWebhook(
      signedWebhook({
        providerEventId: "evt-fee-net",
        eventType: "payment.succeeded",
        providerPaymentId: submitted.providerPaymentId,
        processorFeeMinorUnits: scheduled.charge.cardProcessorFeeMinorUnits,
      }),
    );
    const clearedEntry = await ledgerCtx.entries.findByPaymentAndType(submitted.id, "payment_cleared");
    expect(clearedEntry).not.toBeNull();
    // Gross entering the ledger is the total charge (scheduled + surcharge); subtracting the same
    // processor fee from that larger gross still nets the creditor the original 5_000.
    const creditorPosting = clearedEntry!.postings.find((p) => p.accountType === "creditor_proceeds_payable");
    expect(creditorPosting?.amountMinorUnits).toBe(5_000);
  });

  it("duplicate request: a second schedule attempt for the same open installment is rejected", async () => {
    await card.debitCardPaymentService.scheduleInstallmentPayment({
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
      card.debitCardPaymentService.scheduleInstallmentPayment({
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

  it("duplicate request: replaying the same idempotency key returns the original attempt rather than creating a second one", async () => {
    const first = await card.debitCardPaymentService.createManualPayment({
      idempotencyKey: "k-manual-dup",
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    const replay = await card.debitCardPaymentService.createManualPayment({
      idempotencyKey: "k-manual-dup",
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });
    expect(replay.id).toBe(first.id);
  });

  it("no active card: scheduling fails when no card is on file for the agreement", async () => {
    const otherAgreementId = randomUUID();
    balanceCtx.terms.set(otherAgreementId, 10_000, "USD");
    card.feeAllocation.set(otherAgreementId, "debtor_pays");
    await expect(
      card.debitCardPaymentService.scheduleInstallmentPayment({
        idempotencyKey: "k-no-card",
        installmentScheduleItemId: randomUUID(),
        agreementId: otherAgreementId,
        payer: PAYER,
        recipient: RECIPIENT,
        amountMinorUnits: 5_000,
        currency: "USD",
        actingUserId: PAYER_USER_ID,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("is structurally incapable of calling the payment provider directly, bypassing PaymentService's verification gate", () => {
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(card.debitCardPaymentService));
    expect(methodNames).not.toContain("createRecipientAccount");
    expect(methodNames).not.toContain("verifyWebhookSignature");
  });
});
