import { describe, expect, it } from "vitest";
import { createTestNotificationService } from "./testFakes";

describe("NotificationService", () => {
  it("always records a durable notification_event row per default channel, even when the recipient has no contact info on file", async () => {
    const { notificationService, events } = createTestNotificationService();
    const records = await notificationService.notify({
      recipientUserId: "user-1",
      notificationType: "payment_cleared",
      relatedPaymentAttemptId: "attempt-1",
      relatedAgreementId: "agreement-1",
      payload: { displayAmount: "$100.00" },
    });
    // payment_cleared's default channels are email + in_app.
    expect(records.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
    const emailRecord = records.find((r) => r.channel === "email")!;
    expect(events.byId.get(emailRecord.id)).toBeTruthy();
    expect(emailRecord.status).toBe("pending"); // no email on file — recorded, not delivered.
    // in_app has no external dependency — always delivers immediately.
    const inAppRecord = records.find((r) => r.channel === "in_app")!;
    expect(inAppRecord.status).toBe("delivered");
    expect(inAppRecord.deliveredAt).not.toBeNull();
  });

  it("attempts delivery via email and sms and marks delivered when contact info is present", async () => {
    const { notificationService, contacts, emailSender, smsSender } = createTestNotificationService();
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15551234567");
    const records = await notificationService.notify({
      recipientUserId: "user-1",
      notificationType: "payment_failed", // critical — email + sms + in_app
      payload: { failureCategory: "insufficient_funds" },
    });
    expect(records.map((r) => r.channel).sort()).toEqual(["email", "in_app", "sms"]);
    expect(emailSender.sent).toEqual([
      { to: "user1@example.com", subject: "A payment did not go through", body: expect.stringContaining("insufficient_funds") },
    ]);
    expect(smsSender.sent).toEqual([{ to: "+15551234567", body: expect.stringContaining("insufficient_funds") }]);
    expect(records.every((r) => r.status === "delivered")).toBe(true);
  });

  describe("critical preference override", () => {
    it("a critical notification is sent regardless of the recipient's preference", async () => {
      const { notificationService, contacts, preferences, emailSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      // Attempt to opt out of a critical type — setPreference silently no-ops this.
      await notificationService.setPreference({ userId: "user-1", notificationType: "bank_change", channel: "email", enabled: false });
      expect(await preferences.find("user-1", "bank_change", "email")).toBeNull(); // never stored

      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "bank_change", payload: {} });
      expect(records.some((r) => r.channel === "email")).toBe(true);
      expect(emailSender.sent).toHaveLength(1);
    });

    it("settlement is critical (Product Owner review pass: master spec §26 lists 'approving settlements'/'forgiving debt' as MFA-required, and missing a settlement notification is the same 'real financial harm if silently missed' bar every other critical type is held to)", async () => {
      const { notificationService, contacts, preferences, emailSender, smsSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      contacts.setPhone("user-1", "+15551234567");
      await notificationService.setPreference({ userId: "user-1", notificationType: "settlement", channel: "email", enabled: false });
      expect(await preferences.find("user-1", "settlement", "email")).toBeNull(); // never stored — critical

      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "settlement", payload: {} });
      expect(records.map((r) => r.channel).sort()).toEqual(["email", "in_app", "sms"]);
      expect(emailSender.sent).toHaveLength(1);
      expect(smsSender.sent).toHaveLength(1);
    });

    it("a non-critical notification's preference IS honored — opting out suppresses that channel", async () => {
      const { notificationService, contacts, emailSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      await notificationService.setPreference({ userId: "user-1", notificationType: "agreement_signed", channel: "email", enabled: false });

      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {} });
      expect(records.some((r) => r.channel === "email")).toBe(false);
      expect(records.some((r) => r.channel === "in_app")).toBe(true); // in_app preference untouched, still fires
      expect(emailSender.sent).toHaveLength(0);
    });

    it("opting back in re-enables a previously disabled non-critical channel", async () => {
      const { notificationService, contacts, emailSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      await notificationService.setPreference({ userId: "user-1", notificationType: "agreement_signed", channel: "email", enabled: false });
      await notificationService.setPreference({ userId: "user-1", notificationType: "agreement_signed", channel: "email", enabled: true });

      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {} });
      expect(records.some((r) => r.channel === "email")).toBe(true);
      expect(emailSender.sent).toHaveLength(1);
    });
  });

  describe("delivery dedupe", () => {
    it("a second notify() call with the same dedupeKey returns the existing rows instead of sending again", async () => {
      const { notificationService, contacts, emailSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      const first = await notificationService.notify({
        recipientUserId: "user-1",
        notificationType: "payment_cleared",
        payload: {},
        dedupeKey: "payment_cleared:attempt-1:user-1",
      });
      const second = await notificationService.notify({
        recipientUserId: "user-1",
        notificationType: "payment_cleared",
        payload: {},
        dedupeKey: "payment_cleared:attempt-1:user-1",
      });
      expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
      expect(emailSender.sent).toHaveLength(1); // not sent twice
    });

    it("different recipients of the same logical event get independent dedupe keys", async () => {
      const { notificationService, contacts, emailSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      contacts.set("user-2", "user2@example.com");
      await notificationService.notify({
        recipientUserId: "user-1",
        notificationType: "payment_cleared",
        payload: {},
        dedupeKey: "payment_cleared:attempt-1:user-1",
      });
      await notificationService.notify({
        recipientUserId: "user-2",
        notificationType: "payment_cleared",
        payload: {},
        dedupeKey: "payment_cleared:attempt-1:user-2",
      });
      expect(emailSender.sent).toHaveLength(2);
    });
  });

  describe("authorization", () => {
    it("listForUser never returns another user's notifications", async () => {
      const { notificationService } = createTestNotificationService();
      await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      await notificationService.notify({ recipientUserId: "user-2", notificationType: "payment_cleared", payload: {} });

      const user1Notifications = await notificationService.listForUser("user-1");
      expect(user1Notifications.every((n) => n.recipientUserId === "user-1")).toBe(true);
      const user2Notifications = await notificationService.listForUser("user-2");
      expect(user2Notifications.every((n) => n.recipientUserId === "user-2")).toBe(true);
    });

    it("getPreferences never returns another user's preferences", async () => {
      const { notificationService } = createTestNotificationService();
      await notificationService.setPreference({ userId: "user-1", notificationType: "agreement_signed", channel: "email", enabled: false });
      await notificationService.setPreference({ userId: "user-2", notificationType: "agreement_signed", channel: "sms", enabled: false });

      const user1Prefs = await notificationService.getPreferences("user-1");
      expect(user1Prefs).toEqual([{ notificationType: "agreement_signed", channel: "email", enabled: false }]);
    });
  });

  describe("retry", () => {
    it("a failed delivery is retried and succeeds once due", async () => {
      const { notificationService, contacts, emailSender, events } = createTestNotificationService({ retryDelayMs: 1000, maxAttempts: 3 });
      contacts.set("user-1", "user1@example.com");
      emailSender.failNext = true;

      const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      if (!record) throw new Error("expected a record");
      expect(record.status).toBe("failed");
      expect(record.attemptCount).toBe(1);
      expect(record.nextRetryAt).not.toBeNull();

      // Not yet due.
      const tooEarly = await notificationService.retryDueNotifications(new Date(record.nextRetryAt!.getTime() - 1));
      expect(tooEarly.retried).toBe(0);

      const result = await notificationService.retryDueNotifications(new Date(record.nextRetryAt!.getTime() + 1));
      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(1);
      const updated = await events.findById(record.id);
      expect(updated?.status).toBe("delivered");
      expect(emailSender.sent).toHaveLength(1);
    });

    it("stops retrying once maxAttempts is exhausted", async () => {
      const { notificationService, contacts, emailSender, events } = createTestNotificationService({ retryDelayMs: 0, maxAttempts: 2 });
      contacts.set("user-1", "user1@example.com");
      emailSender.failNext = true;

      const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      if (!record) throw new Error("expected a record");
      expect(record.attemptCount).toBe(1);

      emailSender.failNext = true;
      const now = new Date(Date.now() + 1);
      const result = await notificationService.retryDueNotifications(now);
      expect(result.retried).toBe(1);
      expect(result.failed).toBe(1);

      const updated = await events.findById(record.id);
      expect(updated?.attemptCount).toBe(2); // maxAttempts reached
      expect(updated?.nextRetryAt).toBeNull(); // gives up — no further retry scheduled

      const secondPass = await notificationService.retryDueNotifications(new Date(now.getTime() + 100_000));
      expect(secondPass.retried).toBe(0); // excluded — attemptCount >= maxAttempts
    });
  });
});
