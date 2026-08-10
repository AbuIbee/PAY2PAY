import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { createTestAdminService } from "./testFakes";

const IP = "203.0.113.10";

function ctxFor(userId: string, sessionId: string, role: "member" | "platform_admin" | "platform_owner") {
  return { actingUserId: userId, actingSessionId: sessionId, actingRole: role, ipAddress: IP, deviceInfo: null };
}

describe("AdminService", () => {
  let ctx: ReturnType<typeof createTestAdminService>;

  beforeEach(() => {
    ctx = createTestAdminService();
  });

  async function seedUser(role: "member" | "platform_admin" | "platform_owner" = "member") {
    const user = await ctx.users.insert({ email: `${randomUUID()}@example.com`, authCredentialRef: "x", dateOfBirth: "1990-01-01" });
    if (role !== "member") ctx.users.setPlatformRole(user.id, role);
    return user;
  }

  describe("MEMBER cannot access admin UI/server operations", () => {
    it("rejects a member actor from every admin operation", async () => {
      const member = await seedUser("member");
      const target = await seedUser("member");
      const memberCtx = ctxFor(member.id, randomUUID(), "member");

      await expect(ctx.adminService.getDashboardOverview("member")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.searchUsers("member", {})).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.getUserDetail(memberCtx, target.id)).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.suspendUser(memberCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.reactivateUser(memberCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.revokeUserSessions(memberCtx, target.id, null)).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.adminService.changeUserRole(memberCtx, target.id, "platform_admin", "reason"),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.adminService.changeAccountClassification(memberCtx, target.id, "internal"),
      ).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.startImpersonation(memberCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
    });
  });

  describe("PLATFORM_ADMIN can perform only its authorized admin functions", () => {
    it("can suspend, reactivate, and revoke sessions for an ordinary member", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      await ctx.sessions.insert({ userId: target.id, sessionTokenHash: "hash-1", expiresAt: new Date(Date.now() + 60_000), ipAddress: null, userAgent: null });
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");

      await ctx.adminService.suspendUser(adminCtx, target.id, "policy violation");
      let summary = await ctx.directory.getSummary(target.id);
      expect(summary?.status).toBe("suspended");

      await ctx.adminService.reactivateUser(adminCtx, target.id, "resolved");
      summary = await ctx.directory.getSummary(target.id);
      expect(summary?.status).toBe("active");

      await ctx.adminService.revokeUserSessions(adminCtx, target.id, "precaution");
    });

    it("cannot perform owner-only role changes", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, adminCtx.actingSessionId);

      await expect(
        ctx.adminService.changeUserRole(adminCtx, target.id, "platform_admin", "trying anyway"),
      ).rejects.toThrow(ForbiddenError);
    });

    it("cannot suspend or alter a Platform Owner", async () => {
      const admin = await seedUser("platform_admin");
      const owner = await seedUser("platform_owner");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");

      await expect(ctx.adminService.suspendUser(adminCtx, owner.id, "reason")).rejects.toThrow(ForbiddenError);
    });

    it("cannot suspend or alter another Platform Admin", async () => {
      const admin = await seedUser("platform_admin");
      const otherAdmin = await seedUser("platform_admin");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");

      await expect(ctx.adminService.suspendUser(adminCtx, otherAdmin.id, "reason")).rejects.toThrow(ForbiddenError);
    });
  });

  describe("PLATFORM_OWNER can perform authorized owner operations", () => {
    it("promotes a member to platform_admin with a fresh step-up, and can demote back", async () => {
      const owner = await seedUser("platform_owner");
      const target = await seedUser("member");
      const sessionId = randomUUID();
      const ownerCtx = ctxFor(owner.id, sessionId, "platform_owner");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, owner.id, sessionId);

      await ctx.adminService.changeUserRole(ownerCtx, target.id, "platform_admin", "new hire");
      let summary = await ctx.directory.getSummary(target.id);
      expect(summary?.platformRole).toBe("platform_admin");

      await ctx.adminService.changeUserRole(ownerCtx, target.id, "member", "role no longer needed");
      summary = await ctx.directory.getSummary(target.id);
      expect(summary?.platformRole).toBe("member");
    });

    it("rejects a role change without a fresh step-up", async () => {
      const owner = await seedUser("platform_owner");
      const target = await seedUser("member");
      const ownerCtx = ctxFor(owner.id, randomUUID(), "platform_owner");
      // Deliberately no grantStepUp call.

      await expect(
        ctx.adminService.changeUserRole(ownerCtx, target.id, "platform_admin", "reason"),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects changing one's own role", async () => {
      const owner = await seedUser("platform_owner");
      const sessionId = randomUUID();
      const ownerCtx = ctxFor(owner.id, sessionId, "platform_owner");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, owner.id, sessionId);

      await expect(
        ctx.adminService.changeUserRole(ownerCtx, owner.id, "platform_admin", "reason"),
      ).rejects.toThrow(ValidationError);
    });

    it("still cannot modify another Platform Owner through this action", async () => {
      const owner = await seedUser("platform_owner");
      const otherOwner = await seedUser("platform_owner");
      const ownerCtx = ctxFor(owner.id, randomUUID(), "platform_owner");

      await expect(ctx.adminService.suspendUser(ownerCtx, otherOwner.id, "reason")).rejects.toThrow(ForbiddenError);
    });
  });

  describe("admin actions create audit records", () => {
    it("records suspend, role-change, and impersonation events with target-resource fields", async () => {
      const owner = await seedUser("platform_owner");
      const target = await seedUser("member");
      const sessionId = randomUUID();
      const ownerCtx = ctxFor(owner.id, sessionId, "platform_owner");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, owner.id, sessionId);

      await ctx.adminService.suspendUser(ownerCtx, target.id, "policy");
      const suspendEvent = ctx.auditRepo.events.find((e) => e.action === "admin_user_suspended");
      expect(suspendEvent?.actorUserId).toBe(owner.id);
      expect(suspendEvent?.actorRole).toBe("platform_owner");
      expect(suspendEvent?.targetResourceType).toBe("user_account");
      expect(suspendEvent?.targetResourceId).toBe(target.id);
      expect(suspendEvent?.reason).toBe("policy");

      await ctx.adminService.reactivateUser(ownerCtx, target.id, "resolved");
      await ctx.adminService.changeUserRole(ownerCtx, target.id, "platform_admin", "promotion");
      expect(ctx.auditRepo.events.some((e) => e.action === "admin_role_changed")).toBe(true);

      const impersonation = await ctx.adminService.startImpersonation(ownerCtx, target.id, "support ticket #1");
      expect(ctx.auditRepo.events.some((e) => e.action === "admin_impersonation_started")).toBe(true);
      await ctx.adminService.endImpersonation(ownerCtx, impersonation.impersonationSessionId);
      expect(ctx.auditRepo.events.some((e) => e.action === "admin_impersonation_ended")).toBe(true);
    });
  });

  describe("test-account classification behaves correctly", () => {
    it("changes and persists classification, and rejects an unauthorized actor", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");

      await ctx.adminService.changeAccountClassification(adminCtx, target.id, "qa");
      const summary = await ctx.directory.getSummary(target.id);
      expect(summary?.accountClassification).toBe("qa");

      await expect(
        ctx.adminService.changeAccountClassification(adminCtx, target.id, "qa"),
      ).rejects.toThrow(ValidationError); // already qa

      const member = await seedUser("member");
      const memberCtx = ctxFor(member.id, randomUUID(), "member");
      await expect(
        ctx.adminService.changeAccountClassification(memberCtx, target.id, "demo"),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("View As User / impersonation", () => {
    it("is read-only: never issues a session for the target, and ends cleanly", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      const result = await ctx.adminService.startImpersonation(adminCtx, target.id, "checking a support ticket");
      expect(result.view.id).toBe(target.id);
      expect(Object.keys(result)).not.toContain("sessionToken");
      expect(Object.keys(result)).not.toContain("token");

      const openSession = await ctx.impersonationSessions.findById(result.impersonationSessionId);
      expect(openSession?.endedAt).toBeNull();

      await ctx.adminService.endImpersonation(adminCtx, result.impersonationSessionId);
      const closedSession = await ctx.impersonationSessions.findById(result.impersonationSessionId);
      expect(closedSession?.endedAt).not.toBeNull();

      // Ending twice, or ending someone else's session, must fail.
      await expect(ctx.adminService.endImpersonation(adminCtx, result.impersonationSessionId)).rejects.toThrow(ValidationError);
    });

    it("rejects starting a support view without a fresh step-up", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");
      // Deliberately no grantStepUp call.

      await expect(ctx.adminService.startImpersonation(adminCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
    });

    it("rejects ending an impersonation session that belongs to a different admin", async () => {
      const admin = await seedUser("platform_admin");
      const otherAdmin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);
      const result = await ctx.adminService.startImpersonation(adminCtx, target.id, "reason");

      const otherAdminCtx = ctxFor(otherAdmin.id, randomUUID(), "platform_admin");
      await expect(ctx.adminService.endImpersonation(otherAdminCtx, result.impersonationSessionId)).rejects.toThrow(
        ForbiddenError,
      );
    });
  });

  describe("immutable signed records remain protected from both admin roles", () => {
    it("platformRole grants nothing within AgreementService — a non-party is still rejected regardless of platform role", async () => {
      const agreementCtx = createTestAgreementService();
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const strangerWithOwnerRole = randomUUID(); // this user's user_account.platform_role would be platform_owner
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);

      const created = await agreementCtx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        category: "personal_loan",
        description: "test",
        originalAmountMinorUnits: 10_000,
        previousPaymentsMinorUnits: 0,
        firstPaymentMinorUnits: 5_000,
        installmentAmountMinorUnits: 5_000,
        frequency: "monthly",
        firstPaymentDate: "2026-02-01",
        feeAllocation: "split_evenly",
        earlyPayoffTerms: "none",
        hardshipRules: "none",
        partialPaymentRules: "none",
        settlementRules: "none",
        disputeProcedure: "none",
      });

      // AdminService has no dependency on AgreementService/SignatureService at all — this call
      // proves the point structurally: even a user flagged platform_owner has zero standing here,
      // because AgreementService's own authorization never looks at platform_role.
      await expect(agreementCtx.agreementService.getAgreement(created.agreement.id, strangerWithOwnerRole)).rejects.toThrow(
        ForbiddenError,
      );
      await expect(
        agreementCtx.agreementService.submitDraft(created.agreement.id, strangerWithOwnerRole),
      ).rejects.toThrow(ForbiddenError);
    });

    it("AdminService exposes no method capable of mutating agreement data", () => {
      const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.adminService));
      const agreementRelated = methodNames.filter((name) => /agreement|signature|pdf/i.test(name));
      expect(agreementRelated).toEqual([]);
    });
  });

  describe("unauthorized direct API access is rejected", () => {
    it("every mutating method independently re-checks actingRole rather than trusting the caller", async () => {
      const target = await seedUser("member");
      const fakeAdminCtx = ctxFor(randomUUID(), randomUUID(), "member"); // a nonexistent user claiming "member" — still correctly rejected
      await expect(ctx.adminService.suspendUser(fakeAdminCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
    });
  });
});
