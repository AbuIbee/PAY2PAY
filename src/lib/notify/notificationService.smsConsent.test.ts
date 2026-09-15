import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { createTestNotificationService } from "./testFakes";

/**
 * B0-B (SMS consent / A2P compliance): dedicated coverage for the master SMS consent gate, kept
 * separate from notificationService.test.ts's existing suite (which relies on the shared factory's
 * permissive `smsConsentDefaultActive: true` convenience — see testFakes.ts's own doc comment). Every
 * test here explicitly requests the strict, real-world default (`false`) so it genuinely exercises the
 * mandatory default-off rule, not the shared factory's test-only convenience.
 */
describe("NotificationService — SMS consent (B0-B)", () => {
  it("1/18: a user who has never touched SMS consent has it OFF — no migration, no inference from phone/preferences", async () => {
    const { notificationService, contacts, smsConsents } = createTestNotificationService(undefined, undefined, false);
    contacts.setPhone("user-1", "+15551234567");
    const status = await notificationService.getSmsConsentStatus("user-1");
    expect(status.active).toBe(false);
    expect(status.effectiveActive).toBe(false);
    expect(await smsConsents.find("user-1")).toBeNull();
  });

  it("7: normal transactional SMS is not sent when consent is inactive, even though a phone is on file", async () => {
    const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15551234567");
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
    expect(smsSender.sent).toHaveLength(0);
    const smsRecord = records.find((r) => r.channel === "sms");
    expect(smsRecord?.status).toBe("failed");
    expect(smsRecord?.failureReason).toBe("sms_consent_inactive");
  });

  it("9: a CRITICAL notification type also does not send SMS without active consent — critical only overrides the ordinary per-type preference, never this consent gate", async () => {
    const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15551234567");
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: { failureCategory: "insufficient_funds" } });
    expect(smsSender.sent).toHaveLength(0);
    const smsRecord = records.find((r) => r.channel === "sms");
    expect(smsRecord?.status).toBe("failed");
    expect(smsRecord?.failureReason).toBe("sms_consent_inactive");
    // Email — an unrelated channel — must still fire normally for a critical type.
    expect(records.some((r) => r.channel === "email")).toBe(true);
  });

  it("2/4/5: activating requires a verified phone on file — throws, persists nothing, when none exists", async () => {
    const { notificationService, smsConsents } = createTestNotificationService(undefined, undefined, false);
    await expect(
      notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" }),
    ).rejects.toThrow(ValidationError);
    expect(await smsConsents.find("user-1")).toBeNull();
  });

  it("4/5: enabling with a verified phone persists an active consent record with consentedAt/source/disclosureVersion", async () => {
    const { notificationService, contacts } = createTestNotificationService(undefined, undefined, false);
    contacts.setPhone("user-1", "+15551234567");
    const before = new Date();
    const record = await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    expect(record.active).toBe(true);
    expect(record.source).toBe("web_form");
    expect(record.disclosureVersion).toBe("v1");
    expect(record.consentedAt).not.toBeNull();
    expect(record.consentedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(record.withdrawnAt).toBeNull();
  });

  it("4/5: activation is recorded to the audit trail (who/when/source/disclosure)", async () => {
    const { notificationService, contacts, auditRepo } = createTestNotificationService(undefined, undefined, false);
    contacts.setPhone("user-1", "+15551234567");
    await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    const event = auditRepo.events.find((e) => e.action === "sms_consent_activated");
    expect(event).toBeTruthy();
    expect(event?.actorUserId).toBe("user-1");
    expect(event?.newValue).toMatchObject({ source: "web_form", disclosureVersion: "v1" });
  });

  it("6/8: once active, eligible, and not opted out, normal transactional SMS is actually sent", async () => {
    const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15551234567");
    await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
    expect(smsSender.sent).toHaveLength(1);
    const smsRecord = records.find((r) => r.channel === "sms");
    expect(smsRecord?.status).toBe("sent");
  });

  it("6: disabling persists withdrawal (withdrawnAt set, active false) and is audited", async () => {
    const { notificationService, contacts, auditRepo } = createTestNotificationService(undefined, undefined, false);
    contacts.setPhone("user-1", "+15551234567");
    await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    const before = new Date();
    const record = await notificationService.withdrawSmsConsent("user-1", "user_disabled_in_app");
    expect(record.active).toBe(false);
    expect(record.withdrawnAt).not.toBeNull();
    expect(record.withdrawnAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const event = auditRepo.events.find((e) => e.action === "sms_consent_withdrawn");
    expect(event).toBeTruthy();
    expect(event?.reason).toBe("user_disabled_in_app");
  });

  it("7: after withdrawal, normal transactional SMS is blocked again", async () => {
    const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15551234567");
    await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    await notificationService.withdrawSmsConsent("user-1");
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
    expect(smsSender.sent).toHaveLength(0);
    expect(records.find((r) => r.channel === "sms")?.failureReason).toBe("sms_consent_inactive");
  });

  it("9/10: an inbound STOP suppression is authoritative and is never overridden by a stale active-consent flag — the delivery gate blocks it", async () => {
    const { notificationService, contacts, smsOptOuts, smsSender } = createTestNotificationService(undefined, undefined, false);
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15551234567");
    await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    // Simulate a later inbound STOP for this exact phone, independent of the consent record.
    await smsOptOuts.recordOptOut("+15551234567", "stop_keyword");
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
    expect(smsSender.sent).toHaveLength(0);
    expect(records.find((r) => r.channel === "sms")?.failureReason).toBe("recipient_opted_out");
  });

  it("9/10: getSmsConsentStatus reports effectiveActive=false once STOP-opted-out, even though the stored active flag still reads true — the UI must never show SMS as on", async () => {
    const { notificationService, contacts, smsOptOuts } = createTestNotificationService(undefined, undefined, false);
    contacts.setPhone("user-1", "+15551234567");
    await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    await smsOptOuts.recordOptOut("+15551234567", "stop_keyword");
    const status = await notificationService.getSmsConsentStatus("user-1");
    expect(status.active).toBe(true); // the raw, unmodified consent record — never silently rewritten by STOP.
    expect(status.effectiveActive).toBe(false); // but the effective, UI/delivery-facing truth reflects STOP.
  });

  it("16: consent is user-scoped — activating one user's consent never affects another user's status", async () => {
    const { notificationService, contacts } = createTestNotificationService(undefined, undefined, false);
    contacts.setPhone("user-1", "+15551234567");
    contacts.setPhone("user-2", "+15559876543");
    await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
    const statusUser1 = await notificationService.getSmsConsentStatus("user-1");
    const statusUser2 = await notificationService.getSmsConsentStatus("user-2");
    expect(statusUser1.active).toBe(true);
    expect(statusUser2.active).toBe(false);
  });

  it("14: enabling/disabling SMS consent does not touch the recipient's email eligibility or delivery", async () => {
    const { notificationService, contacts, emailSender, smsSender } = createTestNotificationService(undefined, undefined, false);
    contacts.set("user-1", "user1@example.com");
    contacts.setPhone("user-1", "+15551234567");
    // Consent never activated — SMS stays off, but email must be entirely unaffected.
    const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
    expect(emailSender.sent).toHaveLength(1);
    expect(smsSender.sent).toHaveLength(0);
    const emailRecord = records.find((r) => r.channel === "email");
    expect(emailRecord?.status).toBe("sent");
  });

  describe("B0-B-001 blocker correction: consent bound to the consented phone", () => {
    it("1: activating consent stores the current verified phone (A)", async () => {
      const { notificationService, contacts } = createTestNotificationService(undefined, undefined, false);
      contacts.setPhone("user-1", "+15551110000"); // A
      const record = await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      expect(record.consentedPhoneE164).toBe("+15551110000");
    });

    it("2: current phone A + consent bound to A -> effectively active and eligible to send", async () => {
      const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
      contacts.set("user-1", "user1@example.com");
      contacts.setPhone("user-1", "+15551110000"); // A
      await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      const status = await notificationService.getSmsConsentStatus("user-1");
      expect(status.effectiveActive).toBe(true);
      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
      expect(smsSender.sent).toHaveLength(1);
      expect(records.find((r) => r.channel === "sms")?.status).toBe("sent");
    });

    it("3: user changes current phone A -> B while consent remains bound to A -> effectiveActive=false", async () => {
      const { notificationService, contacts } = createTestNotificationService(undefined, undefined, false);
      contacts.setPhone("user-1", "+15551110000"); // A
      await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      contacts.setPhone("user-1", "+15552220000"); // B — simulates the user replacing their verified phone
      const status = await notificationService.getSmsConsentStatus("user-1");
      expect(status.active).toBe(true); // the raw stored flag is untouched
      expect(status.effectiveActive).toBe(false); // but it no longer covers the current destination
      expect(status.phoneChangedSinceConsent).toBe(true);
    });

    it("4: after A -> B phone change, ordinary transactional SMS to B is blocked with an explicit mismatch reason", async () => {
      const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
      contacts.set("user-1", "user1@example.com");
      contacts.setPhone("user-1", "+15551110000"); // A
      await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      contacts.setPhone("user-1", "+15552220000"); // B
      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
      expect(smsSender.sent).toHaveLength(0);
      const smsRecord = records.find((r) => r.channel === "sms");
      expect(smsRecord?.status).toBe("failed");
      expect(smsRecord?.failureReason).toBe("sms_consent_phone_mismatch");
    });

    it("5: an explicit new web-form opt-in while B is current binds consent to B (a genuinely new affirmative event, not a transfer)", async () => {
      const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
      contacts.set("user-1", "user1@example.com");
      contacts.setPhone("user-1", "+15551110000"); // A
      await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      contacts.setPhone("user-1", "+15552220000"); // B
      const record = await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" }); // fresh opt-in for B
      expect(record.consentedPhoneE164).toBe("+15552220000");
      const status = await notificationService.getSmsConsentStatus("user-1");
      expect(status.effectiveActive).toBe(true);
      await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
      expect(smsSender.sent).toHaveLength(1);
      expect(smsSender.sent[0]?.to).toBe("+15552220000");
    });

    it("6: consent for A cannot authorize B, for a different user entirely — consent is always scoped to one user's own destination, never a bare phone number", async () => {
      const { notificationService, contacts, smsSender } = createTestNotificationService(undefined, undefined, false);
      contacts.set("user-1", "user1@example.com");
      contacts.setPhone("user-1", "+15551110000"); // A, consented
      await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      // A different user who happens to have phone B (never consented) must never receive SMS either,
      // and user-1's consent for A has no bearing on user-2 at all.
      contacts.set("user-2", "user2@example.com");
      contacts.setPhone("user-2", "+15552220000"); // B, never consented
      const records = await notificationService.notify({ recipientUserId: "user-2", notificationType: "amendment", payload: {} });
      expect(smsSender.sent).toHaveLength(0);
      expect(records.find((r) => r.channel === "sms")?.failureReason).toBe("sms_consent_inactive");
    });

    it("7: STOP for A remains authoritative for A even while consent is (still, correctly) bound to A", async () => {
      const { notificationService, contacts, smsOptOuts, smsSender } = createTestNotificationService(undefined, undefined, false);
      contacts.set("user-1", "user1@example.com");
      contacts.setPhone("user-1", "+15551110000"); // A
      await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      await smsOptOuts.recordOptOut("+15551110000", "stop_keyword"); // STOP for A
      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
      expect(smsSender.sent).toHaveLength(0);
      expect(records.find((r) => r.channel === "sms")?.failureReason).toBe("recipient_opted_out");
    });

    it("8: STOP for A does not itself create consent or authorization for B", async () => {
      const { notificationService, contacts, smsOptOuts, smsSender } = createTestNotificationService(undefined, undefined, false);
      contacts.set("user-1", "user1@example.com");
      contacts.setPhone("user-1", "+15551110000"); // A — never consented at all
      await smsOptOuts.recordOptOut("+15551110000", "stop_keyword"); // STOP for A
      contacts.setPhone("user-1", "+15552220000"); // user replaces A with B
      const records = await notificationService.notify({ recipientUserId: "user-1", notificationType: "amendment", payload: {} });
      expect(smsSender.sent).toHaveLength(0);
      // Blocked for lack of consent, not because STOP somehow followed the user to B.
      expect(records.find((r) => r.channel === "sms")?.failureReason).toBe("sms_consent_inactive");
      expect(await smsOptOuts.isOptedOut("+15552220000")).toBe(false);
    });

    it("9: a current-phone mismatch is reflected correctly in the API/UI-facing status, distinct from 'never consented'", async () => {
      const { notificationService, contacts } = createTestNotificationService(undefined, undefined, false);
      contacts.setPhone("user-1", "+15551110000");
      await notificationService.activateSmsConsent("user-1", { source: "web_form", disclosureVersion: "v1" });
      contacts.setPhone("user-1", "+15552220000");
      const mismatchStatus = await notificationService.getSmsConsentStatus("user-1");
      expect(mismatchStatus.phoneChangedSinceConsent).toBe(true);

      const { notificationService: neverConsentedService, contacts: neverConsentedContacts } = createTestNotificationService(undefined, undefined, false);
      neverConsentedContacts.setPhone("user-2", "+15559990000");
      const neverConsentedStatus = await neverConsentedService.getSmsConsentStatus("user-2");
      expect(neverConsentedStatus.phoneChangedSinceConsent).toBe(false);
      expect(neverConsentedStatus.effectiveActive).toBe(false);
    });
  });
});
