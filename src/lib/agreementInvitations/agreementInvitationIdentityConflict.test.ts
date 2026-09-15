import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createTestAgreementInvitationService } from "./testFakes";

/**
 * Codex B0-B blocker correction — B0-B-002 (conflicting email/phone identity) and B0-B-003 (duplicate
 * verified-phone ambiguity): dedicated coverage, kept separate from
 * agreementInvitationSmsConsent.test.ts (which covers the phone-binding/STOP scenarios that test 12a
 * of that file already needed updating for once this correction's conflict rule existed — see that
 * file's own updated test for why). Every test here uses the strict `smsConsentDefaultActive: false`
 * setup.
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

describe("AgreementInvitationService — identity conflict / duplicate phone (B0-B-002 / B0-B-003)", () => {
  let ctx: ReturnType<typeof createTestAgreementInvitationService>;
  let inviterUserId: string;
  const INVITER_PROFILE = { kind: "personal" as const, id: randomUUID() };
  const EMAIL = "recipient@example.com";
  const PHONE_A = "+15551110000";
  const PHONE_B = "+15552220000";
  const PHONE_C = "+15553330000";

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

  function registerConsentedUser(userId: string, phone: string) {
    ctx.notificationCtx.contacts.set(userId, `${userId}@example.com`);
    ctx.notificationCtx.contacts.setPhone(userId, phone);
  }

  describe("identity conflict", () => {
    it("10: email A + phone also resolves A -> unique, consistent identity, sent to A", async () => {
      const userA = randomUUID();
      ctx.users.register(EMAIL, userA);
      ctx.registeredPhones.register(PHONE_A, userA);
      registerConsentedUser(userA, PHONE_A);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userA, { source: "web_form", disclosureVersion: "v1" });

      await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_A });

      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(1);
      expect(ctx.notificationCtx.smsSender.sent[0]?.to).toBe(PHONE_A);
    });

    it("11: email resolves A, phone resolves nobody -> safe A behavior (email establishes A; SMS still only via A's own canonical phone)", async () => {
      const userA = randomUUID();
      ctx.users.register(EMAIL, userA);
      registerConsentedUser(userA, PHONE_A);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userA, { source: "web_form", disclosureVersion: "v1" });

      // PHONE_C is not registered to anyone.
      await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_C });

      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(1);
      expect(ctx.notificationCtx.smsSender.sent[0]?.to).toBe(PHONE_A);
    });

    it("12: unresolved email + phone resolves B -> safe B behavior", async () => {
      const userB = randomUUID();
      ctx.registeredPhones.register(PHONE_B, userB);
      registerConsentedUser(userB, PHONE_B);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userB, { source: "web_form", disclosureVersion: "v1" });

      await createInvitation({ recipientEmail: "nobody-at-all@example.com", recipientPhone: PHONE_B });

      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(1);
      expect(ctx.notificationCtx.smsSender.sent[0]?.to).toBe(PHONE_B);
    });

    it("13: neither email nor phone resolves anyone -> unregistered, no SMS", async () => {
      await createInvitation({ recipientEmail: "nobody@example.com", recipientPhone: PHONE_C });
      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
    });

    it("14/15/16: email A + phone (uniquely) B, A != B -> no user is selected for automated dispatch, and neither A nor B receives SMS", async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      ctx.users.register(EMAIL, userA);
      registerConsentedUser(userA, PHONE_A);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userA, { source: "web_form", disclosureVersion: "v1" });

      ctx.registeredPhones.register(PHONE_B, userB);
      registerConsentedUser(userB, PHONE_B);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userB, { source: "web_form", disclosureVersion: "v1" });

      const { invitation } = await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_B });

      // 14/15/16: neither identity's SMS fires.
      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
      // The invitation itself is never bound to either contested identity.
      expect(invitation.recipientUserId).toBeNull();
      // No automated account-targeted notification (email/in_app via notify()) reached either account.
      const eventsForA = ctx.notificationCtx.events.byId;
      for (const event of eventsForA.values()) {
        expect(event.recipientUserId).not.toBe(userA);
        expect(event.recipientUserId).not.toBe(userB);
      }
    });

    it("conflict is recorded to the internal audit trail with a safe reason, no user id embedded", async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      ctx.users.register(EMAIL, userA);
      ctx.registeredPhones.register(PHONE_B, userB);
      registerConsentedUser(userA, PHONE_A);
      registerConsentedUser(userB, PHONE_B);

      await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_B });

      const conflictEvent = ctx.auditRepo.events.find((e) => e.action === "agreement_invitation_recipient_identity_conflict");
      expect(conflictEvent).toBeTruthy();
      expect(conflictEvent?.newValue).toEqual({ reason: "recipient_identity_conflict" });
      expect(JSON.stringify(conflictEvent)).not.toContain(userA);
      expect(JSON.stringify(conflictEvent)).not.toContain(userB);
    });

    it("17: conflict does not turn the public invitation response into an account-enumeration oracle — same shape as every other outcome", async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      ctx.users.register(EMAIL, userA);
      ctx.registeredPhones.register(PHONE_B, userB);
      registerConsentedUser(userA, PHONE_A);
      registerConsentedUser(userB, PHONE_B);

      const conflictResult = await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_B });
      const unregisteredResult = await createInvitation({ recipientEmail: "nobody@example.com" });

      expect(Object.keys(conflictResult).sort()).toEqual(["invitation", "link", "rawToken"]);
      expect(Object.keys(unregisteredResult).sort()).toEqual(["invitation", "link", "rawToken"]);
      // The secure link/token is still generated for the conflict case (Section "SHARING MUST REMAIN AVAILABLE").
      expect(conflictResult.rawToken).toBeTruthy();
      expect(conflictResult.link).toContain(conflictResult.rawToken);
    });

    it("a plain email is still sent directly in the conflict case (email delivery is not subject to the SMS consent rules)", async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      ctx.users.register(EMAIL, userA);
      ctx.registeredPhones.register(PHONE_B, userB);
      registerConsentedUser(userA, PHONE_A);
      registerConsentedUser(userB, PHONE_B);

      await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_B });

      expect(ctx.notificationCtx.emailSender.sent.some((e) => e.to === EMAIL)).toBe(true);
    });
  });

  describe("duplicate verified phone ambiguity", () => {
    it("18: no phone match -> none (unregistered)", async () => {
      await createInvitation({ recipientPhone: PHONE_C });
      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
    });

    it("19: exactly one distinct user registered to a phone -> unique match, eligible", async () => {
      const userA = randomUUID();
      ctx.registeredPhones.register(PHONE_A, userA);
      registerConsentedUser(userA, PHONE_A);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userA, { source: "web_form", disclosureVersion: "v1" });

      await createInvitation({ recipientPhone: PHONE_A });
      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(1);
    });

    it("20: multiple credential registrations for the SAME user on the same phone are not cross-user ambiguity", async () => {
      const userA = randomUUID();
      ctx.registeredPhones.register(PHONE_A, userA);
      ctx.registeredPhones.register(PHONE_A, userA); // simulates a second credential row, same user
      registerConsentedUser(userA, PHONE_A);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userA, { source: "web_form", disclosureVersion: "v1" });

      await createInvitation({ recipientPhone: PHONE_A });
      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(1);
    });

    it("21/22/23: the same phone registered to two DISTINCT users -> ambiguous, no SMS, no arbitrary/most-recent selection", async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      ctx.registeredPhones.register(PHONE_A, userA);
      ctx.registeredPhones.register(PHONE_A, userB); // registered second — must NOT be arbitrarily preferred as "most recent"
      registerConsentedUser(userA, PHONE_A);
      registerConsentedUser(userB, PHONE_A);
      await ctx.notificationCtx.notificationService.activateSmsConsent(userA, { source: "web_form", disclosureVersion: "v1" });
      await ctx.notificationCtx.notificationService.activateSmsConsent(userB, { source: "web_form", disclosureVersion: "v1" });

      const { invitation } = await createInvitation({ recipientPhone: PHONE_A });

      expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
      expect(invitation.recipientUserId).toBeNull();
    });

    /**
     * Codex FINAL review correction (B0-B-003): the original version of this test asserted the
     * OPPOSITE of the required final matrix — it expected an ambiguous phone to be silently ignored
     * whenever email independently resolved someone, so the email-resolved user still got the SMS.
     * The final review found this reachable and blocking: "email A + phone ambiguous" must suppress
     * ALL automated account-targeted notification, exactly like "email A + phone uniquely B" does,
     * because the ambiguous phone is itself a contradictory/unsafe signal about the exact destination
     * this invitation supplied — it must never be waved through merely because a *different* input
     * (email) happened to resolve. Replaced by the dedicated block below (items 1-5, 10).
     */
    describe("B0-B-003 final correction: ambiguous phone suppresses dispatch even when email independently resolves someone", () => {
      it("1/2: email A + ambiguous phone -> no notify() call for A, no SMS sent to A or anyone else", async () => {
        const userEmail = randomUUID();
        const userX = randomUUID();
        const userY = randomUUID();
        ctx.users.register(EMAIL, userEmail);
        registerConsentedUser(userEmail, PHONE_C);
        await ctx.notificationCtx.notificationService.activateSmsConsent(userEmail, { source: "web_form", disclosureVersion: "v1" });

        // PHONE_A is ambiguous across two OTHER, unrelated users — it does not implicate userEmail at
        // all, but it is still an unsafe, contradictory signal that must suppress dispatch entirely.
        ctx.registeredPhones.register(PHONE_A, userX);
        ctx.registeredPhones.register(PHONE_A, userY);

        const { invitation } = await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_A });

        expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
        expect(invitation.recipientUserId).toBeNull();
        for (const event of ctx.notificationCtx.events.byId.values()) {
          expect(event.recipientUserId).not.toBe(userEmail);
        }
      });

      it("3: email A + ambiguous phone -> the secure invitation link/token is still generated and returned", async () => {
        const userEmail = randomUUID();
        const userX = randomUUID();
        const userY = randomUUID();
        ctx.users.register(EMAIL, userEmail);
        registerConsentedUser(userEmail, PHONE_C);
        ctx.registeredPhones.register(PHONE_A, userX);
        ctx.registeredPhones.register(PHONE_A, userY);

        const result = await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_A });

        expect(result.rawToken).toBeTruthy();
        expect(result.link).toContain(result.rawToken);
      });

      it("4/10: email A + ambiguous phone -> generic response shape, no enumeration fields introduced", async () => {
        const userEmail = randomUUID();
        const userX = randomUUID();
        const userY = randomUUID();
        ctx.users.register(EMAIL, userEmail);
        registerConsentedUser(userEmail, PHONE_C);
        ctx.registeredPhones.register(PHONE_A, userX);
        ctx.registeredPhones.register(PHONE_A, userY);

        const ambiguousResult = await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_A });
        const unregisteredResult = await createInvitation({ recipientEmail: "nobody@example.com" });

        expect(Object.keys(ambiguousResult).sort()).toEqual(["invitation", "link", "rawToken"]);
        expect(Object.keys(unregisteredResult).sort()).toEqual(["invitation", "link", "rawToken"]);
      });

      it("5: no email + ambiguous phone -> no notify() call for either ambiguous candidate", async () => {
        const userX = randomUUID();
        const userY = randomUUID();
        ctx.registeredPhones.register(PHONE_A, userX);
        ctx.registeredPhones.register(PHONE_A, userY);
        registerConsentedUser(userX, PHONE_A);
        registerConsentedUser(userY, PHONE_A);
        await ctx.notificationCtx.notificationService.activateSmsConsent(userX, { source: "web_form", disclosureVersion: "v1" });
        await ctx.notificationCtx.notificationService.activateSmsConsent(userY, { source: "web_form", disclosureVersion: "v1" });

        const { invitation } = await createInvitation({ recipientPhone: PHONE_A });

        expect(ctx.notificationCtx.smsSender.sent).toHaveLength(0);
        expect(invitation.recipientUserId).toBeNull();
        for (const event of ctx.notificationCtx.events.byId.values()) {
          expect(event.recipientUserId).not.toBe(userX);
          expect(event.recipientUserId).not.toBe(userY);
        }
      });

      it("ambiguity is recorded to the internal audit trail with a safe reason, no user id embedded", async () => {
        const userEmail = randomUUID();
        const userX = randomUUID();
        const userY = randomUUID();
        ctx.users.register(EMAIL, userEmail);
        registerConsentedUser(userEmail, PHONE_C);
        ctx.registeredPhones.register(PHONE_A, userX);
        ctx.registeredPhones.register(PHONE_A, userY);

        await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_A });

        const ambiguousEvent = ctx.auditRepo.events.find((e) => e.action === "agreement_invitation_recipient_phone_ambiguous");
        expect(ambiguousEvent).toBeTruthy();
        expect(ambiguousEvent?.newValue).toEqual({ reason: "recipient_phone_ambiguous" });
        expect(JSON.stringify(ambiguousEvent)).not.toContain(userEmail);
        expect(JSON.stringify(ambiguousEvent)).not.toContain(userX);
        expect(JSON.stringify(ambiguousEvent)).not.toContain(userY);
      });

      it("a plain email is still sent directly when the phone is ambiguous (email delivery is not subject to the SMS consent/ambiguity rules)", async () => {
        const userEmail = randomUUID();
        const userX = randomUUID();
        const userY = randomUUID();
        ctx.users.register(EMAIL, userEmail);
        registerConsentedUser(userEmail, PHONE_C);
        ctx.registeredPhones.register(PHONE_A, userX);
        ctx.registeredPhones.register(PHONE_A, userY);

        await createInvitation({ recipientEmail: EMAIL, recipientPhone: PHONE_A });

        expect(ctx.notificationCtx.emailSender.sent.some((e) => e.to === EMAIL)).toBe(true);
      });
    });
  });
});
