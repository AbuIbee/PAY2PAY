import { describe, expect, it } from "vitest";
import { createTestNotificationService } from "./testFakes";

describe("NotificationService", () => {
  it("always records a durable notification_event row, even when the recipient has no email on file", async () => {
    const { notificationService, events } = createTestNotificationService();
    const record = await notificationService.notify({
      recipientUserId: "user-1",
      notificationType: "payment_failed",
      relatedPaymentAttemptId: "attempt-1",
      relatedAgreementId: "agreement-1",
      subject: "subject",
      body: "body",
      payload: { failureCategory: "insufficient_funds" },
    });
    expect(events.byId.get(record.id)).toBeTruthy();
    expect(record.deliveredAt).toBeNull(); // no email on file — recorded, not delivered.
  });

  it("attempts delivery and marks the event delivered when the recipient has an email on file", async () => {
    const { notificationService, contacts, emailSender, events } = createTestNotificationService();
    contacts.set("user-1", "user1@example.com");
    const record = await notificationService.notify({
      recipientUserId: "user-1",
      notificationType: "payment_failed",
      subject: "A payment did not go through",
      body: "details",
      payload: {},
    });
    expect(emailSender.sent).toEqual([{ to: "user1@example.com", subject: "A payment did not go through", body: "details" }]);
    expect((await events.listForUser("user-1"))[0]?.deliveredAt).not.toBeNull();
    void record;
  });
});
