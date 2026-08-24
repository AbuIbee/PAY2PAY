import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestVerificationService } from "./testFakes";

const PROFILE_ID = "profile-1";
const OWNER_USER_ID = "owner-1";
const REVIEWER_USER_ID = "reviewer-1";

describe("VerificationService", () => {
  let ctx: ReturnType<typeof createTestVerificationService>;

  beforeEach(() => {
    ctx = createTestVerificationService();
    ctx.profileOwners.set("personal", PROFILE_ID, OWNER_USER_ID);
  });

  it("is UNVERIFIED with no email verification and no verification record", async () => {
    expect(await ctx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe("UNVERIFIED");
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("is BASIC once the owning user's email is verified", async () => {
    ctx.emailVerification.verifiedUserIds.add(OWNER_USER_ID);
    expect(await ctx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe("BASIC");
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("moves to FULL_PENDING after a verification request, still not fully verified", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    expect(await ctx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe("FULL_PENDING");
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("rejects a second request while one is already pending", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    await expect(ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID)).rejects.toThrow(
      ConflictError,
    );
  });

  it("only reaches FULL_VERIFIED through the audited manual decision path", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    await ctx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_owner",
      profileKind: "personal",
      profileId: PROFILE_ID,
      decision: "verified",
      reviewerUserId: REVIEWER_USER_ID,
      reason: "Manual review passed (mock provider — Sprint 9 wires a real one).",
    });
    expect(await ctx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe("FULL_VERIFIED");
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(true);
  });

  it("records FULL_REJECTED via the same decision path, and isFullyVerified stays false", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    await ctx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_owner",
      profileKind: "personal",
      profileId: PROFILE_ID,
      decision: "rejected",
      reviewerUserId: REVIEWER_USER_ID,
      reason: "Documents did not match.",
    });
    expect(await ctx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe("FULL_REJECTED");
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("cannot self-report: a profile's own owner cannot record their own decision", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    await expect(
      ctx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: "personal",
        profileId: PROFILE_ID,
        decision: "verified",
        reviewerUserId: OWNER_USER_ID, // same as the profile owner
        reason: null,
      }),
    ).rejects.toThrow(ValidationError);
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  // Closed-beta remediation (DEF-UAT-020): recordManualVerificationDecision/listPendingVerificationRequests
  // previously had zero admin-role gate at all — this is the new coverage for that gate.
  it("rejects a decision from a caller with no admin capability", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    await expect(
      ctx.verificationService.recordManualVerificationDecision({
        actingRole: "member",
        profileKind: "personal",
        profileId: PROFILE_ID,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: "ok",
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("allows a decision from a caller holding the compliance internal role (not just a platform_owner bypass)", async () => {
    await ctx.roles.assignRole({
      targetUserId: REVIEWER_USER_ID,
      role: "compliance",
      actingUserId: "owner-actor",
      actingRole: "platform_owner",
      reason: null,
    });
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    // An internal admin role (compliance) is an additional grant on top of already holding the base
    // platform_admin role, not a substitute for it — AdminRoleService.requireCapability's own gate
    // rejects a plain "member" outright before ever consulting the internal-role assignment.
    await ctx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_admin",
      profileKind: "personal",
      profileId: PROFILE_ID,
      decision: "verified",
      reviewerUserId: REVIEWER_USER_ID,
      reason: "ok",
    });
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(true);
  });

  it("listPendingVerificationRequests rejects a caller with no admin capability and returns the queue for an authorized one", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    await expect(ctx.verificationService.listPendingVerificationRequests(REVIEWER_USER_ID, "member")).rejects.toThrow(
      ForbiddenError,
    );
    const pending = await ctx.verificationService.listPendingVerificationRequests(REVIEWER_USER_ID, "platform_owner");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.profileId).toBe(PROFILE_ID);
  });

  it("cannot record a decision without a pending request", async () => {
    await expect(
      ctx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: "personal",
        profileId: PROFILE_ID,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("returns false for every tier below FULL_VERIFIED: UNVERIFIED, BASIC, and FULL_PENDING", async () => {
    // UNVERIFIED (default beforeEach state).
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);

    // BASIC.
    ctx.emailVerification.verifiedUserIds.add(OWNER_USER_ID);
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);

    // FULL_PENDING.
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("audits the request and the decision, hash-chained", async () => {
    await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
    await ctx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_owner",
      profileKind: "personal",
      profileId: PROFILE_ID,
      decision: "verified",
      reviewerUserId: REVIEWER_USER_ID,
      reason: "ok",
    });
    const actions = ctx.auditRepo.events.map((e) => e.action);
    expect(actions).toEqual(["identity_verification_requested", "identity_verification_approved"]);
    expect(ctx.auditRepo.events[1]?.previousEventHash).toBe(ctx.auditRepo.events[0]?.eventHash);
  });

  it("also works for business profiles, isolated from personal profiles", async () => {
    ctx.profileOwners.set("business", "biz-1", OWNER_USER_ID);
    await ctx.verificationService.submitFullVerificationRequest("business", "biz-1");
    await ctx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_owner",
      profileKind: "business",
      profileId: "biz-1",
      decision: "verified",
      reviewerUserId: REVIEWER_USER_ID,
      reason: null,
    });
    expect(await ctx.verificationService.isFullyVerified("business", "biz-1")).toBe(true);
    // The personal profile is unaffected by the business profile's verification.
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  // Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md): the provider-driven
  // counterpart to the manual decision path above — isFullyVerified/getVerificationState are
  // unchanged; only the mechanism producing verified/rejected changes.
  describe("provider-driven decisions (Sprint 9)", () => {
    const PROVIDER_REF = "sandbox_kyc_ref_1";

    it("attaches a provider reference only to a pending record", async () => {
      await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
      await ctx.verificationService.recordProviderSubmission("personal", PROFILE_ID, PROVIDER_REF);
      const record = await ctx.records.findByProviderRef(PROVIDER_REF);
      expect(record?.profileId).toBe(PROFILE_ID);
      expect(record?.status).toBe("pending");
    });

    it("rejects a provider submission with no pending request", async () => {
      await expect(
        ctx.verificationService.recordProviderSubmission("personal", PROFILE_ID, PROVIDER_REF),
      ).rejects.toThrow(ValidationError);
    });

    it("moves FULL_PENDING to FULL_VERIFIED via a provider decision, keyed by provider reference", async () => {
      await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
      await ctx.verificationService.recordProviderSubmission("personal", PROFILE_ID, PROVIDER_REF);
      await ctx.verificationService.recordProviderVerificationDecision({
        providerRef: PROVIDER_REF,
        decision: "verified",
        reason: null,
      });
      expect(await ctx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe("FULL_VERIFIED");
      expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(true);
    });

    it("moves FULL_PENDING to FULL_REJECTED via a provider decision; profile stays gated", async () => {
      await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
      await ctx.verificationService.recordProviderSubmission("personal", PROFILE_ID, PROVIDER_REF);
      await ctx.verificationService.recordProviderVerificationDecision({
        providerRef: PROVIDER_REF,
        decision: "rejected",
        reason: "Document mismatch.",
      });
      expect(await ctx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe("FULL_REJECTED");
      expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
    });

    it("stays gated (isFullyVerified false) throughout PENDING and after REJECTED", async () => {
      await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
      await ctx.verificationService.recordProviderSubmission("personal", PROFILE_ID, PROVIDER_REF);
      expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
      await ctx.verificationService.recordProviderVerificationDecision({
        providerRef: PROVIDER_REF,
        decision: "rejected",
        reason: null,
      });
      expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
    });

    it("rejects a decision for an unknown provider reference", async () => {
      await expect(
        ctx.verificationService.recordProviderVerificationDecision({
          providerRef: "no-such-ref",
          decision: "verified",
          reason: null,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a duplicate/replayed decision for an already-decided record", async () => {
      await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
      await ctx.verificationService.recordProviderSubmission("personal", PROFILE_ID, PROVIDER_REF);
      await ctx.verificationService.recordProviderVerificationDecision({
        providerRef: PROVIDER_REF,
        decision: "verified",
        reason: null,
      });
      await expect(
        ctx.verificationService.recordProviderVerificationDecision({
          providerRef: PROVIDER_REF,
          decision: "rejected",
          reason: null,
        }),
      ).rejects.toThrow(ValidationError);
      // The first (correct) decision is not overwritten by the rejected replay attempt.
      expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(true);
    });

    it("audits provider-driven events with no human actor and a distinct actor role", async () => {
      await ctx.verificationService.submitFullVerificationRequest("personal", PROFILE_ID);
      await ctx.verificationService.recordProviderSubmission("personal", PROFILE_ID, PROVIDER_REF);
      await ctx.verificationService.recordProviderVerificationDecision({
        providerRef: PROVIDER_REF,
        decision: "verified",
        reason: null,
      });
      const events = ctx.auditRepo.events.slice(-2);
      expect(events.map((e) => e.action)).toEqual([
        "identity_verification_provider_submitted",
        "identity_verification_approved",
      ]);
      for (const event of events) {
        expect(event.actorUserId).toBeNull();
        expect(event.actorRole).toBe("kyc_provider");
      }
    });
  });
});
