import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createTestAgreementInvitationService } from "./testFakes";

/**
 * B0-B blocker correction (pre-registration invitation SMS): dedicated coverage for the frozen
 * product decision — automated Paid2You/Twilio agreement-invitation SMS may reach a recipient if and
 * only if they are a REGISTERED Paid2You user with ACTIVE, durable, web-form SMS consent and no
 * authoritative STOP suppression. Every scenario here uses the strict `smsConsentDefaultActive: false`
 * setup (the shared factory's default `true` is a convenience for unrelated pre-existing tests — see
 * testFakes.ts's own doc comment), so it genuinely exercises the mandatory default-off rule.
 */
function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "Personal loan",
    description: "A small personal loan.",
    originalAmountMinorUnits: 50_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 10_000,
    installmentAmountMinorUnits: 10_000,
    frequency: "weekly",
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "May pay off early with no penalty.",
    hardshipRules: "Contact the other party to discuss.",
    partialPaymentRules: "Partial payments accepted.",
    settlementRules: "Settlement may be negotiated.",
    disputeProcedure: "Contact PAY2PAY support.",
    ...overrides,
  };
}

describe("AgreementInvitationService — pre-registration invitation SMS blocker correction (B0-B)", () => {
  let ctx: ReturnType<typeof createTestAgreementInvitationService>;
  let inviterUserId: string;
  const INVITER_PROFILE = { kind: "personal" as const, id: randomUUID() };
  const RECIPIENT_PHONE = "+15559991234";
  const OTHER_PHONE = "+15558887777";

  beforeEach(() => {
    ctx = createTestAgreementInvitationService(undefined, false);
    inviterUserId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", INVITER_PROFILE.id, inviterUserId);
  });

  async function createInvitation(overrides: Parameters<typeof ctx.invitationService.createInvitation>[0] extends infer T ? Partial<T> : never = {}) {
    return ctx.invitationService.createInvitation({
      actingUserId: inviterUserId,
      inviterProfile: INVITER_PROFILE,
      inviterRole: "creditor",
      terms: baseTerms(),
      ...overrides,
    } as Parameters<typeof ctx.invitationService.createInvitation>[0]);
  }

  it("1: an unregistered recipient's phone never triggers an automated Twilio invitation SMS", async () => {
    await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
  });

  it("2: an unregistered recipient never gets a fabricated sms_consent row", async () => {
    const before = ctx.notificationCtx.smsConsents.recordedCount;
    await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    expect(ctx.notificationCtx.smsConsents.recordedCount).toBe(before);
  });

  it("3: a registered recipient (by phone) with no active consent does not receive an automated invitation SMS", async () => {
    const recipientUserId = randomUUID();
    ctx.registeredPhones.register(RECIPIENT_PHONE, recipientUserId);
    ctx.notificationCtx.contacts.setPhone(recipientUserId, RECIPIENT_PHONE);
    // No consent granted.
    await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
  });

  it("4: a registered recipient (by phone) with active consent is eligible to receive the automated invitation SMS", async () => {
    const recipientUserId = randomUUID();
    ctx.registeredPhones.register(RECIPIENT_PHONE, recipientUserId);
    ctx.notificationCtx.contacts.setPhone(recipientUserId, RECIPIENT_PHONE);
    await ctx.notificationCtx.notificationService.activateSmsConsent(recipientUserId, { source: "web_form", disclosureVersion: "v1" });
    await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(1);
    expect(ctx.notificationCtx.smsSender.sent[0]?.to).toBe(RECIPIENT_PHONE);
  });

  it("5: a registered, consenting recipient who has since STOP-opted-out does not receive the automated invitation SMS — STOP remains authoritative", async () => {
    const recipientUserId = randomUUID();
    ctx.registeredPhones.register(RECIPIENT_PHONE, recipientUserId);
    ctx.notificationCtx.contacts.setPhone(recipientUserId, RECIPIENT_PHONE);
    await ctx.notificationCtx.notificationService.activateSmsConsent(recipientUserId, { source: "web_form", disclosureVersion: "v1" });
    await ctx.notificationCtx.smsOptOuts.recordOptOut(RECIPIENT_PHONE, "stop_keyword");
    await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
  });

  it("6a: the originator cannot bypass the gate merely by supplying a phone number for an otherwise-unregistered recipient", async () => {
    // No registeredPhones entry at all for this number — the originator typing it in proves nothing.
    await createInvitation({ recipientPhone: "+15551110000" });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
  });

  it("6b: the originator cannot bypass the gate by also supplying a name/recipientEmail alongside an unregistered phone", async () => {
    await createInvitation({ recipientPhone: RECIPIENT_PHONE, recipientName: "Jordan", recipientEmail: "not-a-real-account@example.com" });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
  });

  it("6c: a per-type notification_preference set to enabled cannot substitute for active sms_consent", async () => {
    const recipientUserId = randomUUID();
    ctx.registeredPhones.register(RECIPIENT_PHONE, recipientUserId);
    ctx.notificationCtx.contacts.setPhone(recipientUserId, RECIPIENT_PHONE);
    // Explicitly "enable" the SMS channel preference for this type — still must not send without
    // separately active sms_consent (the master gate supersedes the per-type preference entirely).
    await ctx.notificationCtx.notificationService.setPreference({ userId: recipientUserId, notificationType: "agreement_invitation", channel: "sms", enabled: true });
    await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
  });

  it("7: the response never discloses whether the phone belongs to a registered Paid2You user, regardless of outcome", async () => {
    const recipientUserId = randomUUID();
    ctx.registeredPhones.register(RECIPIENT_PHONE, recipientUserId);
    ctx.notificationCtx.contacts.setPhone(recipientUserId, RECIPIENT_PHONE);
    await ctx.notificationCtx.notificationService.activateSmsConsent(recipientUserId, { source: "web_form", disclosureVersion: "v1" });

    const sentResult = await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    const blockedResult = await createInvitation({ recipientPhone: OTHER_PHONE }); // unregistered

    // Identical response shape either way — no registered/consent/hasSmsConsent field of any kind.
    expect(Object.keys(sentResult).sort()).toEqual(["invitation", "link", "rawToken"]);
    expect(Object.keys(blockedResult).sort()).toEqual(["invitation", "link", "rawToken"]);
  });

  it("8: the secure invitation link/token is still generated whether or not the automated SMS was sent", async () => {
    const consented = randomUUID();
    ctx.registeredPhones.register(RECIPIENT_PHONE, consented);
    ctx.notificationCtx.contacts.setPhone(consented, RECIPIENT_PHONE);
    await ctx.notificationCtx.notificationService.activateSmsConsent(consented, { source: "web_form", disclosureVersion: "v1" });

    const withSms = await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    const withoutSms = await createInvitation({ recipientPhone: OTHER_PHONE });

    expect(withSms.rawToken).toBeTruthy();
    expect(withSms.link).toContain(withSms.rawToken);
    expect(withoutSms.rawToken).toBeTruthy();
    expect(withoutSms.link).toContain(withoutSms.rawToken);
  });

  it("12a: a recipient resolved by email is never sent to the (unregistered) phone number the inviter also typed in — destination always comes from the resolved user's own canonical phone", async () => {
    const emailUserId = randomUUID();
    ctx.users.register("recipient@example.com", emailUserId);
    ctx.notificationCtx.contacts.set(emailUserId, "recipient@example.com");
    ctx.notificationCtx.contacts.setPhone(emailUserId, "+15550001111"); // the email-matched user's OWN phone
    await ctx.notificationCtx.notificationService.activateSmsConsent(emailUserId, { source: "web_form", disclosureVersion: "v1" });

    // A different, unregistered phone (belongs to no one) is also supplied — per B0-B-002, an
    // unresolved phone never overrides an independently, uniquely resolved email identity.
    await createInvitation({ recipientEmail: "recipient@example.com", recipientPhone: OTHER_PHONE });

    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(1);
    // Sent to the EMAIL-matched user's own canonical phone, never the unrelated typed-in number.
    expect(ctx.notificationCtx.smsSender.sent[0]?.to).toBe("+15550001111");
  });

  it("12b: one user's active consent never authorizes an SMS to a different phone number", async () => {
    const consentingUserId = randomUUID();
    ctx.notificationCtx.contacts.setPhone(consentingUserId, "+15550001111");
    await ctx.notificationCtx.notificationService.activateSmsConsent(consentingUserId, { source: "web_form", disclosureVersion: "v1" });
    // registeredPhones deliberately has NO entry for RECIPIENT_PHONE at all — it belongs to no one.
    await createInvitation({ recipientPhone: RECIPIENT_PHONE });
    expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
  });
});
