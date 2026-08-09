import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
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
        profileKind: "personal",
        profileId: PROFILE_ID,
        decision: "verified",
        reviewerUserId: OWNER_USER_ID, // same as the profile owner
        reason: null,
      }),
    ).rejects.toThrow(ValidationError);
    expect(await ctx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("cannot record a decision without a pending request", async () => {
    await expect(
      ctx.verificationService.recordManualVerificationDecision({
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
});
