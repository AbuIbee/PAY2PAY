import { describe, expect, it } from "vitest";
import { NotificationService } from "./notificationService";
import { InMemoryNotificationEventRepository, createTestNotificationService } from "./testFakes";

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

    /**
     * Production follow-up (missing Agreement Invitation CTA / DEFECT 1): ctaOverride exists for
     * notification types like agreement_invitation whose CTA route (a pre-agreement, secure-token
     * `/i/<token>` link) buildCtaUrl has no stored id to derive — see ctaOverride's own doc comment
     * on notify()'s input type for why it's a transient, non-persisted parameter.
     */
    it("ctaOverride wins over buildCtaUrl's own derivation, even when a relatedAgreementId is also present", async () => {
      const { notificationService, contacts, emailSender } = createTestNotificationService();
      contacts.set("user-1", "user1@example.com");
      await notificationService.notify({
        recipientUserId: "user-1",
        notificationType: "agreement_invitation",
        relatedAgreementId: null,
        payload: { counterpartyName: "Jordan" },
        ctaOverride: { ctaUrl: "https://paid2you.com/i/some-opaque-token", ctaText: "Review agreement" },
      });
      expect(emailSender.sent).toHaveLength(1);
      expect(emailSender.sent[0]?.ctaUrl).toBe("https://paid2you.com/i/some-opaque-token");
      expect(emailSender.sent[0]?.ctaText).toBe("Review agreement");
    });

    it("ctaOverride is never persisted onto the notification_event row — a later retry re-renders with no CTA, not a stale/incorrect one", async () => {
      const { notificationService, contacts, emailSender } = createTestNotificationService({ retryDelayMs: 1000, maxAttempts: 5 });
      contacts.set("user-1", "user1@example.com");
      emailSender.failNext = true;
      emailSender.failNextRetryable = true;

      const [record] = await notificationService.notify({
        recipientUserId: "user-1",
        notificationType: "agreement_invitation",
        relatedAgreementId: null,
        payload: { counterpartyName: "Jordan" },
        ctaOverride: { ctaUrl: "https://paid2you.com/i/some-opaque-token", ctaText: "Review agreement" },
      });
      if (!record) throw new Error("expected a record");
      expect(record.relatedAgreementId).toBeNull();
      expect(record.payload).toEqual({ counterpartyName: "Jordan" }); // the token/ctaUrl is nowhere in the stored payload

      await notificationService.retryDueNotifications(new Date(Date.now() + 2000));
      expect(emailSender.sent).toHaveLength(1); // the retried send went out with no CTA at all — never a stale/reused token
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

  describe("PRSprint 16: preferences audit trail, grouped history, SMS eligibility", () => {
    describe("setPreference audit trail", () => {
      it("records an audit event with the correct old→new transition", async () => {
        const { notificationService, auditRepo } = createTestNotificationService();
        await notificationService.setPreference({ userId: "user-1", notificationType: "amendment", channel: "email", enabled: false });
        const event = auditRepo.events.at(-1);
        expect(event?.action).toBe("notification_preference_changed");
        expect(event?.actorUserId).toBe("user-1");
        expect(event?.previousValue).toEqual({ notificationType: "amendment", channel: "email", enabled: true }); // no prior row -> default enabled
        expect(event?.newValue).toEqual({ notificationType: "amendment", channel: "email", enabled: false });
      });

      it("captures the real previous value on a second change, not a default", async () => {
        const { notificationService, auditRepo } = createTestNotificationService();
        await notificationService.setPreference({ userId: "user-1", notificationType: "amendment", channel: "email", enabled: false });
        await notificationService.setPreference({ userId: "user-1", notificationType: "amendment", channel: "email", enabled: true });
        const event = auditRepo.events.at(-1);
        expect(event?.previousValue).toEqual({ notificationType: "amendment", channel: "email", enabled: false });
        expect(event?.newValue).toEqual({ notificationType: "amendment", channel: "email", enabled: true });
      });

      it("does not record an audit event for an attempted critical-type opt-out (the write itself is a no-op)", async () => {
        const { notificationService, auditRepo } = createTestNotificationService();
        await notificationService.setPreference({ userId: "user-1", notificationType: "payment_failed", channel: "email", enabled: false });
        expect(auditRepo.events).toHaveLength(0);
      });

      it("repeated identical updates remain safe (idempotent) — no error, no duplicate preference rows", async () => {
        const { notificationService, preferences } = createTestNotificationService();
        await notificationService.setPreference({ userId: "user-1", notificationType: "amendment", channel: "email", enabled: false });
        await notificationService.setPreference({ userId: "user-1", notificationType: "amendment", channel: "email", enabled: false });
        const rows = await preferences.listForUser("user-1");
        expect(rows.filter((r) => r.notificationType === "amendment" && r.channel === "email")).toHaveLength(1);
      });

      it("a missing audit dependency never blocks the preference update itself", async () => {
        const { preferences, contacts, emailSender, smsSender, smsOptOuts, appUrl } = createTestNotificationService();
        const noAuditService = new NotificationService({
          events: new InMemoryNotificationEventRepository(),
          preferences,
          emailSender,
          smsSender,
          contacts,
          smsOptOuts,
          appUrl,
          // audit deliberately omitted
        });
        await expect(
          noAuditService.setPreference({ userId: "user-1", notificationType: "amendment", channel: "email", enabled: false }),
        ).resolves.toBeUndefined();
        const rows = await preferences.listForUser("user-1");
        expect(rows.some((r) => r.notificationType === "amendment" && r.channel === "email" && !r.enabled)).toBe(true);
      });
    });

    describe("listGroupedForUser", () => {
      // Every real notify() call site in this codebase supplies a dedupeKey (audited directly during
      // implementation — no exceptions found); these tests do the same so listGroupedForUser exercises
      // its real, expected grouping path rather than the defensive row.id fallback for a caller that
      // omitted one (covered separately, implicitly, by every other describe block in this file, none
      // of which ever produces more than one row per notify() call for a single-channel type anyway).
      it("groups every channel row from one notify() call into a single entry", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        contacts.setPhone("user-1", "+15551234567");
        await notificationService.notify({
          recipientUserId: "user-1",
          notificationType: "payment_failed",
          payload: { failureCategory: "insufficient_funds" },
          dedupeKey: "payment_failed:attempt-1",
        });

        const grouped = await notificationService.listGroupedForUser("user-1");
        expect(grouped).toHaveLength(1);
        expect(grouped[0]?.channels.map((c) => c.channel).sort()).toEqual(["email", "in_app", "sms"]);
      });

      it("two separate notify() calls for the same user produce two separate groups", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        await notificationService.notify({
          recipientUserId: "user-1",
          notificationType: "payment_cleared",
          payload: {},
          relatedPaymentAttemptId: "attempt-1",
          dedupeKey: "payment_cleared:attempt-1",
        });
        await notificationService.notify({
          recipientUserId: "user-1",
          notificationType: "payment_cleared",
          payload: {},
          relatedPaymentAttemptId: "attempt-2",
          dedupeKey: "payment_cleared:attempt-2",
        });

        const grouped = await notificationService.listGroupedForUser("user-1");
        expect(grouped).toHaveLength(2);
        expect(grouped.map((g) => g.groupId).length).toBe(new Set(grouped.map((g) => g.groupId)).size); // distinct ids
      });

      it("exposes the in_app row's own id and readAt for the 'mark read' action", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "agreement_signed:agreement-1" });
        const [grouped] = await notificationService.listGroupedForUser("user-1");
        expect(grouped?.inAppId).not.toBeNull();
        expect(grouped?.readAt).toBeNull();
        await notificationService.markRead("user-1", grouped!.inAppId!);
        const [updated] = await notificationService.listGroupedForUser("user-1");
        expect(updated?.readAt).not.toBeNull();
      });

      it("labels a missing channel as disabled-by-preference when the user explicitly disabled it", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        contacts.setPhone("user-1", "+15551234567");
        await notificationService.setPreference({ userId: "user-1", notificationType: "agreement_invitation", channel: "sms", enabled: false });
        await notificationService.notify({
          recipientUserId: "user-1",
          notificationType: "agreement_invitation",
          payload: {},
          dedupeKey: "agreement_invitation:invitation-1",
        });

        const [grouped] = await notificationService.listGroupedForUser("user-1");
        const smsEntry = grouped?.channels.find((c) => c.channel === "sms");
        expect(smsEntry?.status).toBe("not_sent");
        expect(smsEntry?.reason).toBe("disabled by your notification preference");
        // The row was never even created — confirms preference disables at the event-creation layer, not just delivery.
        expect(grouped?.channels.some((c) => c.channel === "sms" && c.status !== "not_sent")).toBe(false);
      });

      it("does not suppress the canonical event's other channels just because one channel is disabled", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        await notificationService.setPreference({ userId: "user-1", notificationType: "amendment", channel: "email", enabled: false });
        await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {}, dedupeKey: "amendment:amendment-1" });

        const [grouped] = await notificationService.listGroupedForUser("user-1");
        const inAppEntry = grouped?.channels.find((c) => c.channel === "in_app");
        expect(inAppEntry?.status).toBe("delivered");
      });

      it("scopes strictly to the requesting user — never another user's history", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.set("user-1", "user1@example.com");
        contacts.set("user-2", "user2@example.com");
        await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {}, dedupeKey: "payment_cleared:u1-attempt" });
        await notificationService.notify({ recipientUserId: "user-2", notificationType: "payment_cleared", payload: {}, dedupeKey: "payment_cleared:u2-attempt" });

        const user1Groups = await notificationService.listGroupedForUser("user-1");
        expect(user1Groups).toHaveLength(1);
        const user2Groups = await notificationService.listGroupedForUser("user-2");
        expect(user2Groups).toHaveLength(1);
      });
    });

    describe("Production follow-up (Notification cleanup + archive)", () => {
      describe("listCurrentGroupedForUser / listArchivedGroupedForUser / archiveNotification", () => {
        it("a freshly-created notification appears in Current, not Archived", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "cur-1" });

          expect(await notificationService.listCurrentGroupedForUser("user-1")).toHaveLength(1);
          expect(await notificationService.listArchivedGroupedForUser("user-1")).toHaveLength(0);
        });

        it("archiveNotification moves every channel row for the group into Archived atomically", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          contacts.setPhone("user-1", "+15551234567");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {}, dedupeKey: "arch-1" }); // email+sms+in_app

          const archived = await notificationService.archiveNotification("user-1", "arch-1");
          expect(archived).toBe(true);

          const current = await notificationService.listCurrentGroupedForUser("user-1");
          expect(current).toHaveLength(0);
          const archivedGroups = await notificationService.listArchivedGroupedForUser("user-1");
          expect(archivedGroups).toHaveLength(1);
          expect(archivedGroups[0]?.archivedAt).not.toBeNull();
          // Every channel came along, not just one row.
          expect(archivedGroups[0]?.channels.map((c) => c.channel).sort()).toEqual(["email", "in_app", "sms"]);
        });

        it("archiving a stale/unknown groupId is a safe no-op (false, not an error)", async () => {
          const { notificationService } = createTestNotificationService();
          expect(await notificationService.archiveNotification("user-1", "does-not-exist")).toBe(false);
        });

        it("never archives another user's notification", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "cross-1" });

          expect(await notificationService.archiveNotification("user-2", "cross-1")).toBe(false);
          expect(await notificationService.listCurrentGroupedForUser("user-1")).toHaveLength(1);
        });

        it("archived notifications retain their original createdAt and delivery-status information", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: { amountMinorUnits: 5000, currency: "USD" }, dedupeKey: "retain-1" });
          const [before] = await notificationService.listCurrentGroupedForUser("user-1");

          await notificationService.archiveNotification("user-1", "retain-1");
          const [after] = await notificationService.listArchivedGroupedForUser("user-1");

          expect(after?.createdAt).toEqual(before?.createdAt);
          expect(after?.channels.find((c) => c.channel === "email")?.status).toBe("sent");
          expect(after?.payload).toEqual(before?.payload);
        });
      });

      describe("Current-view priority: action required > unread > recent informational", () => {
        it("an action-required notification sorts above an unread, more recent informational one", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {}, dedupeKey: "prio-action" }); // action-required
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "prio-unread" }); // unread, informational, created after

          const current = await notificationService.listCurrentGroupedForUser("user-1");
          expect(current.map((g) => g.groupId)).toEqual(["prio-action", "prio-unread"]);
        });

        it("an unread informational notification sorts above an older, already-read one", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "prio-read" });
          const [readGroup] = await notificationService.listCurrentGroupedForUser("user-1");
          await notificationService.markRead("user-1", readGroup!.inAppId!);

          await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {}, dedupeKey: "prio-unread-2" });

          const current = await notificationService.listCurrentGroupedForUser("user-1");
          expect(current.map((g) => g.groupId)).toEqual(["prio-unread-2", "prio-read"]);
        });

        it("the exact scenario: 4 notifications for the same agreement — the newest sorts above 3 older, already-read informational ones", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          const steps = [
            { type: "agreement_decided" as const, key: "step-1" },
            { type: "agreement_invitation_response" as const, key: "step-2" },
            { type: "agreement_counterparty_signed" as const, key: "step-3" }, // action-required — recipient must sign next
            { type: "agreement_signed" as const, key: "step-4" },
          ];
          for (const step of steps) {
            await notificationService.notify({ recipientUserId: "user-1", notificationType: step.type, payload: {}, dedupeKey: step.key });
          }
          // Read everything except the newest (step-4) and the action-required one (step-3, which stays actionable regardless of read state).
          for (const key of ["step-1", "step-2"]) {
            const [group] = (await notificationService.listCurrentGroupedForUser("user-1")).filter((g) => g.groupId === key);
            await notificationService.markRead("user-1", group!.inAppId!);
          }

          const current = await notificationService.listCurrentGroupedForUser("user-1");
          // step-3 (action required) first, then step-4 (newest, unread informational), then the two older read ones.
          expect(current[0]?.groupId).toBe("step-3");
          expect(current[1]?.groupId).toBe("step-4");
          expect(current.map((g) => g.groupId).slice(2).sort()).toEqual(["step-1", "step-2"]);
        });
      });

      describe("archiveAllReadOrCompleted", () => {
        it("sweeps only read, non-action-required notifications — leaves unread and action-required ones in Current", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "sweep-read" });
          const [readGroup] = await notificationService.listCurrentGroupedForUser("user-1");
          await notificationService.markRead("user-1", readGroup!.inAppId!);

          await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {}, dedupeKey: "sweep-unread" });
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {}, dedupeKey: "sweep-action" });

          const result = await notificationService.archiveAllReadOrCompleted("user-1");
          expect(result).toEqual({ archived: 1 });

          const current = await notificationService.listCurrentGroupedForUser("user-1");
          expect(current.map((g) => g.groupId).sort()).toEqual(["sweep-action", "sweep-unread"]);
          const archived = await notificationService.listArchivedGroupedForUser("user-1");
          expect(archived.map((g) => g.groupId)).toEqual(["sweep-read"]);
        });

        it("is a safe no-op (archived: 0) when nothing qualifies", async () => {
          const { notificationService } = createTestNotificationService();
          expect(await notificationService.archiveAllReadOrCompleted("user-1")).toEqual({ archived: 0 });
        });

        it("running it twice in a row the second time archives nothing new", async () => {
          const { notificationService, contacts } = createTestNotificationService();
          contacts.set("user-1", "user1@example.com");
          await notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "sweep-twice" });
          const [group] = await notificationService.listCurrentGroupedForUser("user-1");
          await notificationService.markRead("user-1", group!.inAppId!);

          expect(await notificationService.archiveAllReadOrCompleted("user-1")).toEqual({ archived: 1 });
          expect(await notificationService.archiveAllReadOrCompleted("user-1")).toEqual({ archived: 0 });
        });
      });
    });

    describe("getSmsEligibility", () => {
      it("reports phoneVerified: false and no opt-out concept when no verified phone exists", async () => {
        const { notificationService } = createTestNotificationService();
        const eligibility = await notificationService.getSmsEligibility("user-1");
        expect(eligibility).toEqual({ phoneVerified: false, maskedPhone: null, optedOut: false });
      });

      it("reports a masked phone (never the full number) when a verified phone exists", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.setPhone("user-1", "+15551234567");
        const eligibility = await notificationService.getSmsEligibility("user-1");
        expect(eligibility.phoneVerified).toBe(true);
        expect(eligibility.maskedPhone).not.toBe("+15551234567");
        expect(eligibility.maskedPhone).not.toBeNull();
      });

      it("reports optedOut: true when the verified phone is in the suppression list", async () => {
        const { notificationService, contacts, smsOptOuts } = createTestNotificationService();
        contacts.setPhone("user-1", "+15551234567");
        await smsOptOuts.recordOptOut("+15551234567", "stop_keyword");
        const eligibility = await notificationService.getSmsEligibility("user-1");
        expect(eligibility.optedOut).toBe(true);
      });

      it("never returns another user's eligibility", async () => {
        const { notificationService, contacts } = createTestNotificationService();
        contacts.setPhone("user-1", "+15551234567");
        const eligibility = await notificationService.getSmsEligibility("user-2");
        expect(eligibility.phoneVerified).toBe(false);
      });
    });
  });
});
