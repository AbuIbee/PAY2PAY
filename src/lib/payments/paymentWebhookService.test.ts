import { beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError, ForbiddenError, ValidationError } from "@/lib/errors";
import { FinancialIntegrityError } from "@/lib/ledger/ledgerService";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createTestPaymentService, createTestPaymentWebhookService } from "./testFakes";
import { classifyProcessingFailure, ProviderLookupEvidenceError } from "./paymentWebhookService";
import type { ProfileKind } from "./paymentProvider";

const PAYER_USER_ID = "payer-user-1";
const RECIPIENT_USER_ID = "recipient-user-1";
const REVIEWER_USER_ID = "reviewer-1";
const PAYER = { profileKind: "personal" as ProfileKind, profileId: "payer-profile-1" };
const RECIPIENT = { profileKind: "business" as ProfileKind, profileId: "recipient-profile-1" };

describe("PaymentWebhookService", () => {
  let paymentCtx: ReturnType<typeof createTestPaymentService>;
  let webhookCtx: ReturnType<typeof createTestPaymentWebhookService>;

  beforeEach(async () => {
    paymentCtx = createTestPaymentService();
    webhookCtx = createTestPaymentWebhookService(paymentCtx);
    paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    for (const ref of [PAYER, RECIPIENT]) {
      await paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
  });

  // PACKAGE B — FINAL NARROW CORRECTION (Codex blocker A): every payment created via
  // PaymentService.createPayment now requires a non-null agreementId (submitToProvider rejects
  // otherwise) — an unregistered id, so the party cross-check this codebase's own convention already
  // skips for unregistered agreements remains unaffected.
  async function createPendingPayment(idempotencyKey: string) {
    return paymentCtx.paymentService.createPayment({
      idempotencyKey,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId: "test-agreement-default",
      actingUserId: PAYER_USER_ID,
      ipAddress: null,
      deviceInfo: null,
    });
  }

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: paymentCtx.provider.signWebhookPayload(rawBody) };
  }

  it("rejects a webhook with an invalid (spoofed) signature", async () => {
    const rawBody = JSON.stringify({ providerEventId: "evt_spoof", eventType: "payment.succeeded" });
    await expect(
      webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader: "0".repeat(64) }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("transitions the matching payment on a valid payment.succeeded event", async () => {
    const record = await createPendingPayment("wh-1");
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_1",
      eventType: "payment.succeeded",
      providerPaymentId: record.providerPaymentId,
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("succeeded");
  });

  it("transitions succeeded -> refunded and succeeded -> disputed via their respective events", async () => {
    const record = await createPendingPayment("wh-2");
    const succeed = signedWebhook({ providerEventId: "evt_2a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(succeed);

    const dispute = signedWebhook({ providerEventId: "evt_2b", eventType: "payment.disputed", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(dispute);
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("disputed");
  });

  it("deduplicates a replayed event: second delivery is a no-op, reported as duplicate", async () => {
    const record = await createPendingPayment("wh-3");
    const event = signedWebhook({ providerEventId: "evt_3", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId });

    const first = await webhookCtx.paymentWebhookService.receiveWebhook(event);
    expect(first.status).toBe("processed");
    const second = await webhookCtx.paymentWebhookService.receiveWebhook(event);
    expect(second.status).toBe("duplicate");

    // Only one payment-status audit entry was recorded — the replay did not reapply the transition.
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.succeeded")).toHaveLength(1);
  });

  // R09 corrective pass (Codex blocker 3B): a RECOGNIZED financial event type with no matching
  // payment must remain unresolved/retryable — never silently "processed" (a real success could have
  // no ledger entry ever posted if this were treated as a safe no-op). "accepted" means durably
  // recorded and retryable, not lost.
  it("does not mark an event for an unknown provider payment id as processed — remains retryable", async () => {
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_unknown",
      eventType: "payment.succeeded",
      providerPaymentId: "sandbox_pay_does_not_exist",
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("accepted");
    const eventRow = await webhookCtx.events.findByProviderEvent("sandbox_mock", "evt_unknown");
    expect(eventRow?.processingStatus).toBe("failed"); // retryable-failed, not permanently poisoned.
    expect(eventRow?.nextRetryAt).not.toBeNull();
  });

  // SPRINT_19_FraudRisk_SecurityHardening: previously applyEvent applied EVENT_TYPE_TO_STATUS
  // unconditionally regardless of the payment's current status. A stale/out-of-order webhook
  // (different event type, so the (provider, providerEventId) replay-dedup above never catches it)
  // arriving after a terminal status was already reached could regress it — e.g. a delayed
  // "payment.failed" landing after "payment.refunded" already posted would flip status back to
  // "failed" and re-run the failed-payment workflow against an already-refunded payment.
  it("ignores a stale out-of-order event that would regress an already-terminal payment status", async () => {
    const record = await createPendingPayment("wh-stale-1");
    const succeed = signedWebhook({ providerEventId: "evt_stale_1a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(succeed);
    const refund = signedWebhook({ providerEventId: "evt_stale_1b", eventType: "payment.refunded", providerPaymentId: record.providerPaymentId });
    await webhookCtx.paymentWebhookService.receiveWebhook(refund);
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refunded");

    // A delayed "payment.failed" for the same payment arrives after the refund already posted.
    const stale = signedWebhook({ providerEventId: "evt_stale_1c", eventType: "payment.failed", providerPaymentId: record.providerPaymentId });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook(stale);
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("refunded");
    expect(webhookCtx.auditRepo.events.filter((e) => e.action === "payment_webhook_payment.failed")).toHaveLength(0);
  });

  it("silently accepts (as processed) an event type it does not recognize", async () => {
    const record = await createPendingPayment("wh-4");
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_unrecognized",
      eventType: "payment.something_new",
      providerPaymentId: record.providerPaymentId,
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("processed");
    expect((await paymentCtx.payments.findById(record.id))?.status).toBe("pending");
  });

  describe("notifications (Sprint 17 Product Owner review pass: payment_cleared/payment_disputed were templates/classifications with no real trigger anywhere in the codebase until this pass)", () => {
    it("notifies both parties on payment.succeeded (payment_cleared) and payment.disputed (payment_disputed)", async () => {
      const notifyCtx = createTestNotificationService();
      notifyCtx.contacts.set(PAYER_USER_ID, "payer@example.com");
      notifyCtx.contacts.set(RECIPIENT_USER_ID, "recipient@example.com");
      const wired = createTestPaymentWebhookService(
        paymentCtx,
        undefined,
        undefined,
        notifyCtx.notificationService,
        paymentCtx.verificationCtx.profileOwners,
      );

      const record = await createPendingPayment("wh-notify-1");
      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_notify_1a", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
      );
      expect(notifyCtx.emailSender.sent).toHaveLength(2); // both parties, payment_cleared

      const payerNotifications = await notifyCtx.notificationService.listForUser(PAYER_USER_ID);
      expect(payerNotifications.some((n) => n.notificationType === "payment_cleared")).toBe(true);

      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_notify_1b", eventType: "payment.disputed", providerPaymentId: record.providerPaymentId }),
      );
      expect(notifyCtx.emailSender.sent).toHaveLength(4); // 2 more, payment_disputed (critical, both parties again)
      const payerNotificationsAfterDispute = await notifyCtx.notificationService.listForUser(PAYER_USER_ID);
      expect(payerNotificationsAfterDispute.some((n) => n.notificationType === "payment_disputed")).toBe(true);
    });

    it("does not fail the webhook if notification delivery is unavailable/unwired — notifications remain optional, matching failedPaymentWorkflow's identical precedent", async () => {
      // The shared beforeEach's webhookCtx was constructed without notifications/profileOwners at all.
      const record = await createPendingPayment("wh-notify-2");
      const result = await webhookCtx.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_notify_2", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
      );
      expect(result.status).toBe("processed");
      expect((await paymentCtx.payments.findById(record.id))?.status).toBe("succeeded");
    });
  });

  describe("SPRINT_19_FraudRisk_SecurityHardening: repeated-payment-failure risk signal", () => {
    it("records a risk signal for the payer on a failed transition", async () => {
      const wired = createTestPaymentWebhookService(paymentCtx, undefined, undefined, undefined, paymentCtx.verificationCtx.profileOwners);
      const record = await createPendingPayment("wh-risk-1");
      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_risk_1", eventType: "payment.failed", providerPaymentId: record.providerPaymentId }),
      );
      const signals = wired.riskCtx.riskEvents.events.filter((e) => e.signalType === "repeated_payment_failure");
      expect(signals).toHaveLength(1);
      expect(signals[0]?.userId).toBe(PAYER_USER_ID);
      expect(signals[0]?.relatedResourceId).toBe(record.id);
    });

    it("does not record a signal on a non-failure transition", async () => {
      const wired = createTestPaymentWebhookService(paymentCtx, undefined, undefined, undefined, paymentCtx.verificationCtx.profileOwners);
      const record = await createPendingPayment("wh-risk-2");
      await wired.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_risk_2", eventType: "payment.succeeded", providerPaymentId: record.providerPaymentId }),
      );
      expect(wired.riskCtx.riskEvents.events).toHaveLength(0);
    });

    it("never fails the webhook when profileOwners is not wired — riskEvents remains optional", async () => {
      // The shared beforeEach's webhookCtx was constructed without profileOwners at all.
      const record = await createPendingPayment("wh-risk-3");
      const result = await webhookCtx.paymentWebhookService.receiveWebhook(
        signedWebhook({ providerEventId: "evt_risk_3", eventType: "payment.failed", providerPaymentId: record.providerPaymentId }),
      );
      expect(result.status).toBe("processed");
    });
  });
});

describe("PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 4): ProviderLookupEvidenceError has its own EXPLICITLY-recognized error taxonomy entry", () => {
  it("classifies ProviderLookupEvidenceError as retryable/unresolved with its own distinct code — never the generic ValidationError code", () => {
    const result = classifyProcessingFailure(new ProviderLookupEvidenceError("payment_provider_lookup_incomplete_or_mismatched_amount"));
    expect(result.retryable).toBe(true);
    expect(result.code).toBe("provider_lookup_evidence_incomplete_or_invalid");
    expect(result.code).not.toBe("unresolved_financial_prerequisite"); // the generic ValidationError fallback code — must not be reached for this type.
  });

  it("is an instanceof ValidationError (codebase error-hierarchy consistency) but is checked BEFORE the generic ValidationError branch", () => {
    const error = new ProviderLookupEvidenceError("payment_provider_lookup_excessive_processor_fee");
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.name).toBe("ProviderLookupEvidenceError");
    expect(classifyProcessingFailure(error).code).toBe("provider_lookup_evidence_incomplete_or_invalid");
  });

  it("is never classified as FinancialIntegrityError (permanent/poison) — remains retryable even though it represents malformed financial evidence", () => {
    const result = classifyProcessingFailure(new ProviderLookupEvidenceError("payment_provider_lookup_invalid_combined_fees"));
    expect(result.retryable).toBe(true);
    expect(result.code).not.toBe("invalid_financial_data"); // FinancialIntegrityError's own code — reserved for genuinely impossible INTERNAL state.
  });

  it("regression: FinancialIntegrityError, ordinary ValidationError, and ConfigurationError keep their own EXISTING classification, unaffected by the new branch", () => {
    expect(classifyProcessingFailure(new FinancialIntegrityError("impossible"))).toEqual({ retryable: false, code: "invalid_financial_data" });
    expect(classifyProcessingFailure(new ValidationError("ordinary"))).toEqual({ retryable: true, code: "unresolved_financial_prerequisite" });
    expect(classifyProcessingFailure(new ConfigurationError("config"))).toEqual({ retryable: true, code: "repairable_configuration_defect" });
    expect(classifyProcessingFailure(new Error("transient"))).toEqual({ retryable: true, code: "transient_processing_error" });
  });
});
