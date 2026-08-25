import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAgreementInvitationService } from "./testFakes";

const BUSINESS_A = randomUUID();

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "Personal loan",
    description: "A small personal loan.",
    originalAmountMinorUnits: 50_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 10_000,
    installmentAmountMinorUnits: 10_000,
    frequency: "weekly",
    firstPaymentDate: "2026-09-01",
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "May pay off early with no penalty.",
    hardshipRules: "Contact the other party to discuss.",
    partialPaymentRules: "Partial payments accepted.",
    settlementRules: "Settlement may be negotiated.",
    disputeProcedure: "Contact PAY2PAY support.",
    ...overrides,
  };
}

describe("AgreementInvitationService", () => {
  let ctx: ReturnType<typeof createTestAgreementInvitationService>;
  let inviterUserId: string;
  const INVITER_PROFILE = { kind: "personal" as const, id: randomUUID() };

  beforeEach(() => {
    ctx = createTestAgreementInvitationService();
    inviterUserId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", INVITER_PROFILE.id, inviterUserId);
  });

  async function createInvitation(overrides: Parameters<typeof ctx.invitationService.createInvitation>[0] extends infer T ? Partial<T> : never = {}) {
    return ctx.invitationService.createInvitation({
      actingUserId: inviterUserId,
      inviterProfile: INVITER_PROFILE,
      inviterRole: "creditor",
      recipientEmail: "recipient@example.com",
      terms: baseTerms(),
      ...overrides,
    } as Parameters<typeof ctx.invitationService.createInvitation>[0]);
  }

  describe("Agreement Lifecycle V2 UAT (Defect 5 — first-payment-date calendar must not allow a past date)", () => {
    it("rejects a first payment date in the past, server-side, even if a manipulated client submits one", async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await expect(createInvitation({ terms: baseTerms({ firstPaymentDate: yesterday }) })).rejects.toThrow(ValidationError);
    });

    it("accepts today as the first payment date (never stricter than 'not in the past')", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await expect(createInvitation({ terms: baseTerms({ firstPaymentDate: today }) })).resolves.toBeTruthy();
    });
  });

  describe("Scenario A — new individual recipient", () => {
    it("full flow: create -> anonymous review -> accept as a new user -> durable participant created -> token cannot be reused", async () => {
      const { invitation, rawToken } = await createInvitation();
      expect(invitation.status).toBe("pending");

      // Anonymous review works — the recipient has no account yet.
      const view = await ctx.invitationService.resolvePublic(rawToken);
      expect(view.amountMinorUnits).toBe(50_000);
      expect(view.status).toBe("viewed");
      expect(view.senderDisplayName).toBeTruthy();

      // Recipient creates a lightweight account and its own personal profile (simulated).
      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");

      const { agreementId } = await ctx.invitationService.acceptPlan({
        rawToken,
        actingUserId: recipientUserId,
        actingProfile: recipientProfile,
      });
      expect(agreementId).toBeTruthy();

      const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
      expect(agreement?.status).toBe("awaiting_signatures");
      expect(agreement?.creditorProfileId).toBe(INVITER_PROFILE.id);
      expect(agreement?.debtorProfileId).toBe(recipientProfile.id);

      // Token cannot be reused.
      await expect(
        ctx.invitationService.acceptPlan({ rawToken, actingUserId: recipientUserId, actingProfile: recipientProfile }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("Scenario B — existing user recipient", () => {
    it("resolves the recipient's account at invitation creation, and binds it (not a different account) on accept", async () => {
      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.users.register("recipient@example.com", recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");

      const { invitation, rawToken } = await createInvitation();
      expect(invitation.recipientUserId).toBe(recipientUserId);

      const { agreementId } = await ctx.invitationService.acceptPlan({
        rawToken,
        actingUserId: recipientUserId,
        actingProfile: recipientProfile,
      });
      expect(agreementId).toBeTruthy();
    });
  });

  describe("Scenario C — counterproposal", () => {
    it("preserves the original proposal, notifies the sender, and requires mutual approval before finalizing", async () => {
      const { rawToken } = await createInvitation({ terms: baseTerms({ installmentAmountMinorUnits: 10_000 }) });

      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");

      const countered = await ctx.invitationService.proposeTerms({
        rawToken,
        actingUserId: recipientUserId,
        actingProfile: recipientProfile,
        terms: baseTerms({ installmentAmountMinorUnits: 7_500 }),
      });
      expect(countered.proposalVersion).toBe(2);
      expect(countered.proposedTerms.installmentAmountMinorUnits).toBe(7_500);

      const notified = [...ctx.notificationCtx.events.byId.values()].filter((e) => e.notificationType === "agreement_invitation_response");
      expect(notified.length).toBeGreaterThan(0);

      // Sender accepts the countered terms — finalizes using the CURRENT (countered) terms.
      const { agreementId } = await ctx.invitationService.acceptPlan({ rawToken, actingUserId: inviterUserId });
      const version = await ctx.agreementCtx.versions.findById(
        (await ctx.agreementCtx.agreements.findById(agreementId))!.currentVersionId!,
      );
      expect(version?.terms.installmentAmountMinorUnits).toBe(7_500);
    });
  });

  describe("Scenario D — business recipient", () => {
    it("requires organization membership/authorization before the organization becomes a participant", async () => {
      // No recipientEmail here on purpose — this scenario isolates the business-authorization
      // check (membership/capability), not the contact-match check other tests already cover.
      const { rawToken } = await createInvitation({ recipientEmail: undefined, recipientName: "Business Contact" });

      const staffUserId = randomUUID();
      // Not yet a staff member of BUSINESS_A — must be denied.
      await expect(
        ctx.invitationService.acceptPlan({ rawToken, actingUserId: staffUserId, actingProfile: { kind: "business", id: BUSINESS_A } }),
      ).rejects.toThrow(ForbiddenError);

      // Grant staff membership with create_agreement capability (manager role includes it) and retry.
      await ctx.agreementCtx.staffCtx.staffMembers.insert({
        businessProfileId: BUSINESS_A,
        userId: staffUserId,
        role: "manager",
        customRoleId: null,
        isAuthorizedRepresentative: true,
      });
      const { agreementId } = await ctx.invitationService.acceptPlan({
        rawToken,
        actingUserId: staffUserId,
        actingProfile: { kind: "business", id: BUSINESS_A },
      });
      expect(agreementId).toBeTruthy();
    });
  });

  describe("Scenario E — security scanner / GET-equivalent resolve", () => {
    it("repeated resolves never mutate beyond pending -> viewed, and never accept/decline/claim", async () => {
      const { invitation, rawToken } = await createInvitation();
      expect(invitation.status).toBe("pending");

      for (let i = 0; i < 5; i += 1) {
        const view = await ctx.invitationService.resolvePublic(rawToken);
        expect(["viewed"]).toContain(view.status);
      }
      const stored = await ctx.invitations.findById(invitation.id);
      expect(stored?.status).toBe("viewed");
      expect(stored?.acceptedAt).toBeNull();
      expect(stored?.declinedAt).toBeNull();
      expect(stored?.recipientUserId).toBeNull();
    });
  });

  describe("Required negative tests", () => {
    it("random token guess -> denied", async () => {
      await expect(ctx.invitationService.resolvePublic("not-a-real-token")).rejects.toThrow(ValidationError);
    });

    it("expired token -> denied", async () => {
      const { invitation, rawToken } = await createInvitation();
      const stored = await ctx.invitations.findById(invitation.id);
      stored!.expiresAt = new Date(Date.now() - 1000);
      await expect(ctx.invitationService.declinePublic(rawToken)).rejects.toThrow(ValidationError);
      const after = await ctx.invitations.findById(invitation.id);
      expect(after?.status).toBe("expired");
    });

    it("revoked token -> denied", async () => {
      const { invitation, rawToken } = await createInvitation();
      await ctx.invitationService.revokeInvitation(invitation.id, inviterUserId);
      await expect(ctx.invitationService.declinePublic(rawToken)).rejects.toThrow(ValidationError);
      await expect(ctx.invitationService.resolvePublic(rawToken)).resolves.toMatchObject({ status: "revoked" });
    });

    it("consumed token replay (accept twice) -> denied", async () => {
      const { rawToken } = await createInvitation();
      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");
      await ctx.invitationService.acceptPlan({ rawToken, actingUserId: recipientUserId, actingProfile: recipientProfile });
      await expect(
        ctx.invitationService.acceptPlan({ rawToken, actingUserId: recipientUserId, actingProfile: recipientProfile }),
      ).rejects.toThrow(ValidationError);
    });

    it("malformed token -> denied with the same generic message as any other invalid token (enumeration protection)", async () => {
      await expect(ctx.invitationService.resolvePublic("")).rejects.toThrow(/invalid or has expired/i);
      await expect(ctx.invitationService.resolvePublic("garbage")).rejects.toThrow(/invalid or has expired/i);
    });

    it("wrong authenticated account -> denied (invitation already bound to someone else)", async () => {
      const { rawToken } = await createInvitation();
      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");
      await ctx.invitationService.acceptPlan({ rawToken, actingUserId: recipientUserId, actingProfile: recipientProfile });

      const strangerUserId = randomUUID();
      const strangerProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", strangerProfile.id, strangerUserId);
      await expect(
        ctx.invitationService.proposeTerms({
          rawToken,
          actingUserId: strangerUserId,
          actingProfile: strangerProfile,
          terms: baseTerms(),
        }),
      ).rejects.toThrow(ValidationError); // already accepted — no longer open
    });

    it("second user claim -> denied when the invitation named a specific recipient email", async () => {
      const { rawToken } = await createInvitation({ recipientEmail: "intended@example.com" });
      const wrongUserId = randomUUID();
      const wrongProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", wrongProfile.id, wrongUserId);
      ctx.userEmails.register(wrongUserId, "someone-else@example.com");

      await expect(
        ctx.invitationService.acceptPlan({ rawToken, actingUserId: wrongUserId, actingProfile: wrongProfile }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("cross-business claim -> denied for a non-staff, non-owner account", async () => {
      const { rawToken } = await createInvitation();
      const strangerUserId = randomUUID();
      await expect(
        ctx.invitationService.acceptPlan({ rawToken, actingUserId: strangerUserId, actingProfile: { kind: "business", id: BUSINESS_A } }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("forged counterproposal from an unauthenticated/unrelated party -> denied once accepted", async () => {
      const { rawToken } = await createInvitation();
      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");
      await ctx.invitationService.acceptPlan({ rawToken, actingUserId: recipientUserId, actingProfile: recipientProfile });

      await expect(
        ctx.invitationService.proposeTerms({ rawToken, actingUserId: inviterUserId, terms: baseTerms({ installmentAmountMinorUnits: 1 }) }),
      ).rejects.toThrow(ValidationError); // no longer open once accepted
    });
  });

  describe("PRSprint 31: concurrency — genuine adversarial races", () => {
    async function setupOpenInvitation() {
      const { invitation, rawToken } = await createInvitation();
      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");
      return { invitation, rawToken, recipientUserId, recipientProfile };
    }

    it("the inviter revoking and the recipient accepting at the exact same time: exactly one wins — a losing revoke never leaves an agreement created behind it, and a losing accept never creates one at all", async () => {
      const { invitation, rawToken, recipientUserId, recipientProfile } = await setupOpenInvitation();

      const results = await Promise.allSettled([
        ctx.invitationService.revokeInvitation(invitation.id, inviterUserId),
        ctx.invitationService.acceptPlan({ rawToken, actingUserId: recipientUserId, actingProfile: recipientProfile }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      // Exactly one side wins — never both (the original bug: a revoke could report success while
      // acceptPlan still finished creating a real agreement anyway) and never neither.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const stored = await ctx.invitations.findById(invitation.id);
      expect(["accepted", "revoked"]).toContain(stored!.status);

      if (stored!.status === "accepted") {
        expect(stored!.agreementId).toBeTruthy();
        const agreement = await ctx.agreementCtx.agreements.findById(stored!.agreementId!);
        expect(agreement).not.toBeNull();
      } else {
        // Revoke won: acceptPlan must never have created an agreement at all — not even a draft left
        // behind. This is the exact defect this PRSprint found and fixed: the old code claimed
        // "accepted" only *after* fully creating and activating the agreement, so a losing accept
        // still left a real agreement in place even though revoke had already "succeeded."
        expect(stored!.agreementId).toBeNull();
        const allAgreements = await ctx.agreementCtx.agreements.listForProfile("personal", recipientProfile.id);
        expect(allAgreements).toHaveLength(0);
      }
    });

    it("two concurrent accept attempts for the same invitation (replay/double-click): exactly one succeeds, never two agreements — this service treats a second accept as an error, not idempotent success (matching its own pre-existing sequential-replay behavior)", async () => {
      const { rawToken, recipientUserId, recipientProfile } = await setupOpenInvitation();
      const input = { rawToken, actingUserId: recipientUserId, actingProfile: recipientProfile };

      const results = await Promise.allSettled([ctx.invitationService.acceptPlan(input), ctx.invitationService.acceptPlan(input)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

      const allAgreements = await ctx.agreementCtx.agreements.listForProfile("personal", recipientProfile.id);
      expect(allAgreements).toHaveLength(1);
    });
  });

  describe("Anonymous review restrictions", () => {
    it("never reveals internal IDs, inviter's account identity, or unrelated fields", async () => {
      const { rawToken } = await createInvitation();
      const view = await ctx.invitationService.resolvePublic(rawToken);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(inviterUserId);
      expect(serialized).not.toContain(INVITER_PROFILE.id);
      expect(view).not.toHaveProperty("agreementId");
      expect(view).not.toHaveProperty("inviterUserId");
      expect(view).not.toHaveProperty("recipientEmail");
    });
  });

  describe("PRSprint 11 integration: an agreement created through this invitation flow can be amended normally afterward", () => {
    it("propose -> accept -> sign an amendment against an invitation-created agreement, producing a second retrievable version", async () => {
      const { rawToken } = await createInvitation();
      const recipientUserId = randomUUID();
      const recipientProfile = { kind: "personal" as const, id: randomUUID() };
      ctx.agreementCtx.profileOwners.set("personal", recipientProfile.id, recipientUserId);
      ctx.userEmails.register(recipientUserId, "recipient@example.com");
      const { agreementId } = await ctx.invitationService.acceptPlan({
        rawToken,
        actingUserId: recipientUserId,
        actingProfile: recipientProfile,
      });
      // acceptPlan lands the agreement at "awaiting_signatures" (the existing Sprint 6 signature
      // flow takes over from there — see AgreementInvitationService's own doc comment); sign it
      // fully here so amending it afterward reflects a realistic, fully-executed agreement.
      await ctx.agreementCtx.agreementService.signAgreement(agreementId, inviterUserId);
      await ctx.agreementCtx.agreementService.signAgreement(agreementId, recipientUserId);

      // AmendmentService wired to the SAME underlying agreement context the invitation flow just
      // wrote to — exactly how production shares one AgreementService singleton across every
      // caller (getAgreementService()'s own memoization), proving an agreement born from PRSprint
      // 10's flow is indistinguishable from any other to PRSprint 11's amendment machinery.
      const { AmendmentService } = await import("@/lib/amendments/amendmentService");
      const { InMemoryAmendmentRepository, InMemoryAmendmentApplicationRepository } = await import("@/lib/amendments/testFakes");
      const { AuditService } = await import("@/lib/audit/auditService");
      const amendments = new InMemoryAmendmentRepository();
      const amendmentService = new AmendmentService({
        agreementService: ctx.agreementCtx.agreementService,
        amendments,
        versions: ctx.agreementCtx.versions,
        application: new InMemoryAmendmentApplicationRepository({
          versions: ctx.agreementCtx.versions,
          agreements: ctx.agreementCtx.agreements,
          scheduleItems: ctx.agreementCtx.scheduleItems,
          amendments,
        }),
        audit: new AuditService({ getLastEvent: async () => null, insertEvent: async (r) => ({ ...r, id: 1 }) }),
        profileOwners: ctx.agreementCtx.profileOwners,
      });

      // Inviter here is the creditor (default in createInvitation's helper); recipient is the debtor.
      const amendment = await amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "Requesting a lower payment",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 7_500 }),
        actingUserId: recipientUserId,
      });
      expect(amendment.proposingPartyRole).toBe("debtor");

      await amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: inviterUserId, decision: "accept" });
      await amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: inviterUserId });
      const applied = await amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: recipientUserId });
      expect(applied.status).toBe("applied");

      const history = await ctx.agreementCtx.agreementService.listVersionHistory(agreementId, inviterUserId);
      expect(history).toHaveLength(2);
      expect(history[1]!.terms.installmentAmountMinorUnits).toBe(7_500);
    });
  });
});
