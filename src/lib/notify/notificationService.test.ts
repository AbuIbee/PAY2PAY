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

  it("attempts delivery via email and sms and marks sent/delivered appropriately when contact info is present", async () => {
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
    // PRSprint 14/15: both email and sms now report "sent" (provider accepted) rather than
    // "delivered" — actual delivery confirmation only ever arrives later, via each provider's own
    // webhook. Only in_app (no external provider — existing is delivery) still goes straight to
    // "delivered".
    const emailRecord = records.find((r) => r.channel === "email")!;
    expect(emailRecord.status).toBe("sent");
    expect(emailRecord.sentAt).not.toBeNull();
    const smsRecord = records.find((r) => r.channel === "sms")!;
    expect(smsRecord.status).toBe("sent");
    expect(smsRecord.sentAt).not.toBeNull();
    const inAppRecord = records.find((r) => r.channel === "in_app")!;
    expect(inAppRecord.status).toBe("delivered");
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

    it("markRead marks a notification read only for its own recipient, and is a no-op for another user's notification", async () => {
      const { notificationService } = createTestNotificationService();
      const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      if (!record) throw new Error("expected a record");
      expect(record.readAt).toBeNull();

      const deniedForOtherUser = await notificationService.markRead("user-2", record.id);
      expect(deniedForOtherUser).toBeNull();
      const stillUnread = await notificationService.listForUser("user-1");
      expect(stillUnread[0]?.readAt).toBeNull();

      const updated = await notificationService.markRead("user-1", record.id);
      expect(updated?.readAt).not.toBeNull();
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
      // PRSprint 14: email retries into "sent" (provider accepted), not "delivered" — see this
      // file's other updated assertion above for the full rationale.
      expect(updated?.status).toBe("sent");
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

  describe("PRSprint 14: production email delivery", () => {
    it("builds a CTA link to the related agreement and passes it to the email sender", async () => {
      const { notificationService, contacts, emailSender, appUrl } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      await notificationService.notify({
        recipientUserId: "user-1",
        notificationType: "agreement_signed",
        relatedAgreementId: "agreement-42",
        payload: {},
      });
      expect(emailSender.sent).toHaveLength(1);
      expect(emailSender.sent[0]?.ctaUrl).toBe(`${appUrl}/agreements/detail?id=agreement-42`);
      expect(emailSender.sent[0]?.ctaText).toBeTruthy();
    });

    it("omits ctaUrl entirely when the event has no relatedAgreementId", async () => {
      const { notificationService, contacts, emailSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      await notificationService.notify({ recipientUserId: "user-1", notificationType: "security_event", payload: { description: "New device sign-in" } });
      expect(emailSender.sent).toHaveLength(1);
      expect(emailSender.sent[0]?.ctaUrl).toBeUndefined();
    });

    it("a non-retryable EmailDeliveryError dead-letters immediately instead of exhausting the retry budget", async () => {
      const { notificationService, contacts, emailSender, events } = createTestNotificationService({ retryDelayMs: 1000, maxAttempts: 5 });
      contacts.set("user-1", "user1@example.com");
      emailSender.failNext = true;
      emailSender.failNextRetryable = false;

      const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      if (!record) throw new Error("expected a record");
      const updated = await events.findById(record.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.attemptCount).toBe(1); // only the one attempt was ever made
      expect(updated?.nextRetryAt).toBeNull(); // no further retry scheduled — dead-lettered on the first try
    });

    it("a retryable EmailDeliveryError still uses the normal bounded-retry/backoff path", async () => {
      const { notificationService, contacts, emailSender, events } = createTestNotificationService({ retryDelayMs: 1000, maxAttempts: 5 });
      contacts.set("user-1", "user1@example.com");
      emailSender.failNext = true;
      emailSender.failNextRetryable = true;

      const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
      if (!record) throw new Error("expected a record");
      const updated = await events.findById(record.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.attemptCount).toBe(1);
      expect(updated?.nextRetryAt).not.toBeNull(); // retry is still scheduled — attempts remain
    });

    describe("recordProviderDeliveryEvent (webhook-driven)", () => {
      it("marks a row delivered on a provider 'delivered' event, correlated by providerMessageId", async () => {
        const { notificationService, contacts, emailSender, events } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        emailSender.setNextProviderMessageId("msg_123");
        const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
        if (!record) throw new Error("expected a record");
        expect((await events.findById(record.id))?.status).toBe("sent");

        const updated = await notificationService.recordProviderDeliveryEvent("msg_123", "delivered", "", new Date());
        expect(updated?.status).toBe("delivered");
        expect(updated?.deliveredAt).not.toBeNull();
      });

      it("marks a row permanently failed (no further retry) on a bounce, without touching other rows", async () => {
        const { notificationService, contacts, emailSender, events } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        contacts.set("user-2", "user2@example.com");
        emailSender.setNextProviderMessageId("msg_bounced");
        const [record1] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
        emailSender.setNextProviderMessageId("msg_other");
        const [record2] = await notificationService.notify({ recipientUserId: "user-2", notificationType: "payment_cleared", payload: {} });
        if (!record1 || !record2) throw new Error("expected records");

        const updated = await notificationService.recordProviderDeliveryEvent("msg_bounced", "failed", "provider_bounced", new Date());
        expect(updated?.status).toBe("failed");
        expect(updated?.failureReason).toBe("provider_bounced");
        expect(updated?.nextRetryAt).toBeNull();
        // The other recipient's row is untouched.
        expect((await events.findById(record2.id))?.status).toBe("sent");
      });

      it("marks a row permanently failed on a complaint", async () => {
        const { notificationService, contacts, emailSender } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        emailSender.setNextProviderMessageId("msg_complained");
        await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
        const updated = await notificationService.recordProviderDeliveryEvent("msg_complained", "failed", "provider_complaint", new Date());
        expect(updated?.status).toBe("failed");
        expect(updated?.failureReason).toBe("provider_complaint");
      });

      it("returns null for an unknown providerMessageId instead of throwing", async () => {
        const { notificationService } = createTestNotificationService();
        const result = await notificationService.recordProviderDeliveryEvent("no-such-message", "delivered", "", new Date());
        expect(result).toBeNull();
      });
    });

    describe("redeliverFailedEvent (admin retry)", () => {
      it("re-attempts a failed event and succeeds", async () => {
        const { notificationService, contacts, emailSender, events } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        emailSender.failNext = true;
        const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
        if (!record) throw new Error("expected a record");
        expect((await events.findById(record.id))?.status).toBe("failed");

        const retried = await notificationService.redeliverFailedEvent(record.id);
        expect(retried.status).toBe("sent");
        expect(emailSender.sent).toHaveLength(1);
      });

      it("rejects a retry attempt on an event that is not currently failed (already succeeded)", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        const [record] = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} });
        if (!record) throw new Error("expected a record");
        expect(record.status).toBe("sent");
        await expect(notificationService.redeliverFailedEvent(record.id)).rejects.toThrow();
      });

      it("rejects a retry attempt on an unknown id", async () => {
        const { notificationService } = createTestNotificationService();
        await expect(notificationService.redeliverFailedEvent("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
      });
    });

    it("listRecentByChannel returns only rows for the requested channel, most recent first", async () => {
      const { notificationService, contacts } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {} }); // email + in_app
      const recent = await notificationService.listRecentByChannel("email", 10);
      expect(recent.every((r) => r.channel === "email")).toBe(true);
      expect(recent.length).toBeGreaterThan(0);
    });
  });

  describe("PRSprint 15: production SMS delivery", () => {
    it("appends the agreement link to the SMS body when the event has a relatedAgreementId", async () => {
      const { notificationService, contacts, smsSender, appUrl } = createTestNotificationService();
      contacts.setPhone("user-1", "+15551234567");
      await notificationService.notify({
        recipientUserId: "user-1",
        notificationType: "agreement_action_required",
        relatedAgreementId: "agreement-42",
        payload: {},
      });
      expect(smsSender.sent).toHaveLength(1);
      expect(smsSender.sent[0]?.body).toContain(`${appUrl}/agreements/detail?id=agreement-42`);
    });

    it("never even attempts a send to an opted-out phone number", async () => {
      const { notificationService, contacts, smsSender, smsOptOuts } = createTestNotificationService();
      contacts.setPhone("user-1", "+15551234567");
      await smsOptOuts.recordOptOut("+15551234567", "stop_keyword");
      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
      const smsRecord = records.find((r) => r.channel === "sms")!;
      expect(smsSender.sent).toHaveLength(0);
      expect(smsRecord.status).toBe("failed");
      expect(smsRecord.failureReason).toBe("recipient_opted_out");
      expect(smsRecord.nextRetryAt).toBeNull();
    });

    it("a non-retryable SmsDeliveryError dead-letters immediately instead of exhausting the retry budget", async () => {
      const { notificationService, contacts, smsSender, events } = createTestNotificationService({ retryDelayMs: 1000, maxAttempts: 5 });
      contacts.setPhone("user-1", "+15551234567");
      smsSender.failNext = true;
      smsSender.failNextRetryable = false;

      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
      const record = records.find((r) => r.channel === "sms")!;
      const updated = await events.findById(record.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.attemptCount).toBe(1);
      expect(updated?.nextRetryAt).toBeNull();
    });

    it("a retryable SmsDeliveryError still uses the normal bounded-retry/backoff path", async () => {
      const { notificationService, contacts, smsSender, events } = createTestNotificationService({ retryDelayMs: 1000, maxAttempts: 5 });
      contacts.setPhone("user-1", "+15551234567");
      smsSender.failNext = true;
      smsSender.failNextRetryable = true;

      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
      const record = records.find((r) => r.channel === "sms")!;
      const updated = await events.findById(record.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.nextRetryAt).not.toBeNull();
    });

    it("recordSmsOptOut is idempotent and only ever called by the inbound webhook route", async () => {
      const { notificationService, smsOptOuts } = createTestNotificationService();
      await notificationService.recordSmsOptOut("+15551234567");
      await notificationService.recordSmsOptOut("+15551234567"); // repeated STOP reply — no error, no duplicate effect
      expect(await smsOptOuts.isOptedOut("+15551234567")).toBe(true);
    });

    describe("recordProviderDeliveryEvent (sms channel)", () => {
      it("marks an sms row delivered on a provider 'delivered' status callback", async () => {
        const { notificationService, contacts, smsSender, events } = createTestNotificationService();
        contacts.setPhone("user-1", "+15551234567");
        smsSender.setNextProviderMessageId("SM_123");
        const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
        const record = records.find((r) => r.channel === "sms")!;
        expect((await events.findById(record.id))?.status).toBe("sent");

        const updated = await notificationService.recordProviderDeliveryEvent("SM_123", "delivered", "", new Date());
        expect(updated?.status).toBe("delivered");
      });

      it("marks an sms row permanently failed on an 'undelivered' status callback", async () => {
        const { notificationService, contacts, smsSender } = createTestNotificationService();
        contacts.setPhone("user-1", "+15551234567");
        smsSender.setNextProviderMessageId("SM_undelivered");
        await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });

        const updated = await notificationService.recordProviderDeliveryEvent("SM_undelivered", "failed", "provider_status_undelivered", new Date());
        expect(updated?.status).toBe("failed");
        expect(updated?.failureReason).toBe("provider_status_undelivered");
        expect(updated?.nextRetryAt).toBeNull();
      });
    });

    it("listRecentByChannel(\"sms\", ...) returns only sms-channel rows", async () => {
      const { notificationService, contacts } = createTestNotificationService();
      contacts.setPhone("user-1", "+15551234567");
      await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} }); // email + sms + in_app
      const recent = await notificationService.listRecentByChannel("sms", 10);
      expect(recent.every((r) => r.channel === "sms")).toBe(true);
      expect(recent.length).toBeGreaterThan(0);
    });
  });
});
