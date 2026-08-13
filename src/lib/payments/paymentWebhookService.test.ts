import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createTestPaymentService, createTestPaymentWebhookService } from "./testFakes";
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
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
  });

  async function createPendingPayment(idempotencyKey: string) {
    return paymentCtx.paymentService.createPayment({
      idempotencyKey,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
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

  it("silently accepts (as processed) an event for an unknown provider payment id", async () => {
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_unknown",
      eventType: "payment.succeeded",
      providerPaymentId: "sandbox_pay_does_not_exist",
    });
    const result = await webhookCtx.paymentWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("processed");
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
});
