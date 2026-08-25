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

  async function seedBusiness(ownerId: string) {
    return ctx.businesses.insert({
      ownerUserId: ownerId,
      legalBusinessName: `Acme ${randomUUID()} LLC`,
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
  }

  describe("MEMBER cannot access admin UI/server operations", () => {
    it("rejects a member actor from every admin operation", async () => {
      const member = await seedUser("member");
      const target = await seedUser("member");
      const memberCtx = ctxFor(member.id, randomUUID(), "member");
      const business = await seedBusiness(target.id);

      await expect(ctx.adminService.getDashboardOverview("member")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.searchUsers("member", {})).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.getUserDetail(memberCtx, target.id)).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.suspendUser(memberCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.reactivateUser(memberCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.revokeUserSessions(memberCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.adminService.changeUserRole(memberCtx, target.id, "platform_admin", "reason"),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.adminService.changeAccountClassification(memberCtx, target.id, "internal"),
      ).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.startImpersonation(memberCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.searchBusinesses("member", {})).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.getBusinessDetail(memberCtx, business.id)).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.suspendBusiness(memberCtx, business.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.reactivateBusiness(memberCtx, business.id, "reason")).rejects.toThrow(ForbiddenError);
    });
  });

  /** Section K (closed-beta remediation, Product Owner review): admin search by the user-facing "P2P-XXXXXXXX" reference. */
  describe("Section K: search by account reference", () => {
    it("finds a user by their public reference, case-insensitively", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const adminCtx = { actingUserId: admin.id, actingSessionId: randomUUID(), actingRole: "platform_admin" as const, ipAddress: IP, deviceInfo: null };
      const detail = await ctx.adminService.getUserDetail(adminCtx, target.id);
      expect(detail.publicReference).toMatch(/^P2P-/);

      const results = await ctx.adminService.searchUsers("platform_admin", { publicReference: detail.publicReference!.toLowerCase() });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(target.id);
    });

    it("returns no results for an unknown reference", async () => {
      await seedUser("platform_admin");
      const results = await ctx.adminService.searchUsers("platform_admin", { publicReference: "P2P-ZZZZZZZZ" });
      expect(results).toHaveLength(0);
    });
  });

  describe("PLATFORM_ADMIN can perform only its authorized admin functions", () => {
    it("can suspend, reactivate, and revoke sessions for an ordinary member", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      await ctx.sessions.insert({ userId: target.id, sessionTokenHash: "hash-1", expiresAt: new Date(Date.now() + 60_000), ipAddress: null, userAgent: null });
      const adminSessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, adminSessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, adminSessionId);

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

  describe("PRSprint 11B: PLATFORM_ADMIN business administration", () => {
    it("can search, view, suspend, and reactivate a business owned by a Member", async () => {
      const admin = await seedUser("platform_admin");
      const owner = await seedUser("member");
      const business = await seedBusiness(owner.id);
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      const found = await ctx.adminService.searchBusinesses("platform_admin", { businessId: business.id });
      expect(found.map((b) => b.id)).toContain(business.id);

      const detail = await ctx.adminService.getBusinessDetail(adminCtx, business.id);
      expect(detail.status).toBe("active");
      expect(detail.ownerEmail).toBe(owner.email);

      await ctx.adminService.suspendBusiness(adminCtx, business.id, "policy violation");
      expect((await ctx.businessDirectory.getSummary(business.id))?.status).toBe("disabled");

      await ctx.adminService.reactivateBusiness(adminCtx, business.id, "resolved");
      expect((await ctx.businessDirectory.getSummary(business.id))?.status).toBe("active");
    });

    it("cannot suspend a business owned by a Platform Admin or a Platform Owner", async () => {
      const admin = await seedUser("platform_admin");
      const otherAdmin = await seedUser("platform_admin");
      const owner = await seedUser("platform_owner");
      const adminOwnedBusiness = await seedBusiness(otherAdmin.id);
      const ownerOwnedBusiness = await seedBusiness(owner.id);
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");

      await expect(ctx.adminService.suspendBusiness(adminCtx, adminOwnedBusiness.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.suspendBusiness(adminCtx, ownerOwnedBusiness.id, "reason")).rejects.toThrow(ForbiddenError);
    });

    it("rejects suspend/reactivate without a fresh step-up", async () => {
      const admin = await seedUser("platform_admin");
      const owner = await seedUser("member");
      const business = await seedBusiness(owner.id);
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");
      // Deliberately no grantStepUp call.

      await expect(ctx.adminService.suspendBusiness(adminCtx, business.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.reactivateBusiness(adminCtx, business.id, "reason")).rejects.toThrow(ForbiddenError);
    });

    it("Platform Owner can suspend a business regardless of who owns it", async () => {
      const owner = await seedUser("platform_owner");
      const otherAdmin = await seedUser("platform_admin");
      const business = await seedBusiness(otherAdmin.id);
      const sessionId = randomUUID();
      const ownerCtx = ctxFor(owner.id, sessionId, "platform_owner");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, owner.id, sessionId);

      await ctx.adminService.suspendBusiness(ownerCtx, business.id, "policy");
      expect((await ctx.businessDirectory.getSummary(business.id))?.status).toBe("disabled");
    });

    it("rejects acting on an already-suspended/already-active business", async () => {
      const admin = await seedUser("platform_admin");
      const owner = await seedUser("member");
      const business = await seedBusiness(owner.id);
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      await expect(ctx.adminService.reactivateBusiness(adminCtx, business.id, "reason")).rejects.toThrow(ValidationError);
      await ctx.adminService.suspendBusiness(adminCtx, business.id, "reason");
      await expect(ctx.adminService.suspendBusiness(adminCtx, business.id, "reason again")).rejects.toThrow(ValidationError);
    });

    it("records suspend/reactivate as audit events against the business_profile target", async () => {
      const admin = await seedUser("platform_admin");
      const owner = await seedUser("member");
      const business = await seedBusiness(owner.id);
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      await ctx.adminService.suspendBusiness(adminCtx, business.id, "policy");
      const event = ctx.auditRepo.events.find((e) => e.action === "admin_business_suspended");
      expect(event?.targetResourceType).toBe("business_profile");
      expect(event?.targetResourceId).toBe(business.id);
      expect(event?.reason).toBe("policy");
    });
  });

  describe("PRSprint 06: suspend/reactivate/revoke-sessions require a fresh step-up", () => {
    it("rejects suspend, reactivate, and revoke-sessions without a fresh step-up", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");
      // Deliberately no grantStepUp call.

      await expect(ctx.adminService.suspendUser(adminCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.reactivateUser(adminCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.revokeUserSessions(adminCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
    });

    it("accepts suspend/reactivate/revoke-sessions once a fresh step-up exists", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      await ctx.adminService.suspendUser(adminCtx, target.id, "policy");
      await ctx.adminService.reactivateUser(adminCtx, target.id, "resolved");
      await ctx.adminService.revokeUserSessions(adminCtx, target.id, "precaution");
    });
  });

  /**
   * Section D (closed-beta remediation, Product Owner review): account lifecycle beyond
   * suspend/reactivate — close/deactivate (status-only, no destructive deletion) and an
   * admin-triggered password reset reusing AuthService's own token/email flow.
   */
  describe("Section D: close account / manual password reset", () => {
    it("requires a fresh step-up before closing an account", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");
      // Deliberately no grantStepUp call.

      await expect(ctx.adminService.closeUser(adminCtx, target.id, "reason")).rejects.toThrow(ForbiddenError);
    });

    it("closes an account without deleting it, and revokes existing sessions", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      await ctx.sessions.insert({ userId: target.id, sessionTokenHash: "hash-close", expiresAt: new Date(Date.now() + 60_000), ipAddress: null, userAgent: null });
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      await ctx.adminService.closeUser(adminCtx, target.id, "account closure requested");

      const summary = await ctx.directory.getSummary(target.id);
      expect(summary?.status).toBe("closed");
      expect(summary?.email).toBeTruthy();
      const stillActive = await ctx.sessions.listActiveForUser(target.id, new Date());
      expect(stillActive).toHaveLength(0);
      const closeEvent = ctx.auditRepo.events.find((e) => e.action === "admin_user_closed");
      expect(closeEvent?.reason).toBe("account closure requested");
    });

    it("rejects closing an already-closed account", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);
      await ctx.adminService.closeUser(adminCtx, target.id, "first closure");

      await expect(ctx.adminService.closeUser(adminCtx, target.id, "second closure")).rejects.toThrow(ValidationError);
    });

    it("requires a fresh step-up before sending a password reset", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");

      await expect(ctx.adminService.sendPasswordReset(adminCtx, target.id, "user locked out")).rejects.toThrow(ForbiddenError);
    });

    it("sends a password reset email to the target and records an admin-attributed audit entry", async () => {
      const admin = await seedUser("platform_admin");
      const target = await seedUser("member");
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      await ctx.adminService.sendPasswordReset(adminCtx, target.id, "user locked out");

      expect(ctx.emailSender.sent.some((email) => email.to === target.email)).toBe(true);
      const sentEvent = ctx.auditRepo.events.find((e) => e.action === "admin_password_reset_sent");
      expect(sentEvent?.actorUserId).toBe(admin.id);
      expect(sentEvent?.targetResourceId).toBe(target.id);
      expect(sentEvent?.reason).toBe("user locked out");
    });

    it("cannot close or send a password reset for a Platform Owner", async () => {
      const admin = await seedUser("platform_admin");
      const owner = await seedUser("platform_owner");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");

      await expect(ctx.adminService.closeUser(adminCtx, owner.id, "reason")).rejects.toThrow(ForbiddenError);
      await expect(ctx.adminService.sendPasswordReset(adminCtx, owner.id, "reason")).rejects.toThrow(ForbiddenError);
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

    /**
     * PRSprint 11B negative-security matrix item "suspended admin loses appropriate access" /
     * "revoked session cannot continue admin activity": suspending a Platform Admin (something only
     * a Platform Owner may do — authorizeMutableTarget) must immediately revoke every one of that
     * admin's existing sessions, not just prevent future logins — proven directly here rather than
     * only inferred from the identical, already-covered member-suspension test above.
     */
    it("suspending a Platform Admin revokes every one of their existing sessions immediately", async () => {
      const owner = await seedUser("platform_owner");
      const admin = await seedUser("platform_admin");
      const adminSession = await ctx.sessions.insert({
        userId: admin.id,
        sessionTokenHash: "admin-session-hash",
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: null,
        userAgent: null,
      });
      const ownerSessionId = randomUUID();
      const ownerCtx = ctxFor(owner.id, ownerSessionId, "platform_owner");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, owner.id, ownerSessionId);

      await ctx.adminService.suspendUser(ownerCtx, admin.id, "policy violation");

      const stillActive = await ctx.sessions.listActiveForUser(admin.id, new Date());
      expect(stillActive.map((s) => s.id)).not.toContain(adminSession.id);
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

    /**
     * PRSprint 11B: closes the "hidden persistent support session" gap named in this PRSprint's
     * Goal — before this, an admin could start any number of concurrent support views (each staying
     * open, endedAt: null, indefinitely) with no way to ever rediscover most of them from the UI.
     * Now at most one may be open per admin at a time.
     */
    it("rejects starting a second support view while one is already active, and getActiveImpersonation surfaces it", async () => {
      const admin = await seedUser("platform_admin");
      const targetA = await seedUser("member");
      const targetB = await seedUser("member");
      const sessionId = randomUUID();
      const adminCtx = ctxFor(admin.id, sessionId, "platform_admin");
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);

      const first = await ctx.adminService.startImpersonation(adminCtx, targetA.id, "checking a ticket");

      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);
      await expect(ctx.adminService.startImpersonation(adminCtx, targetB.id, "second ticket")).rejects.toThrow(
        ValidationError,
      );

      const active = await ctx.adminService.getActiveImpersonation(adminCtx);
      expect(active?.impersonationSessionId).toBe(first.impersonationSessionId);
      expect(active?.targetUserId).toBe(targetA.id);

      await ctx.adminService.endImpersonation(adminCtx, first.impersonationSessionId);
      expect(await ctx.adminService.getActiveImpersonation(adminCtx)).toBeNull();

      // Now that the first has ended, a new one may start.
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, admin.id, sessionId);
      const second = await ctx.adminService.startImpersonation(adminCtx, targetB.id, "second ticket, retried");
      expect(second.impersonationSessionId).not.toBe(first.impersonationSessionId);
    });

    it("getActiveImpersonation returns null for an admin with no open support view, and rejects a non-admin caller", async () => {
      const admin = await seedUser("platform_admin");
      const adminCtx = ctxFor(admin.id, randomUUID(), "platform_admin");
      expect(await ctx.adminService.getActiveImpersonation(adminCtx)).toBeNull();

      const member = await seedUser("member");
      const memberCtx = ctxFor(member.id, randomUUID(), "member");
      await expect(ctx.adminService.getActiveImpersonation(memberCtx)).rejects.toThrow(ForbiddenError);
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
        firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
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

  describe("PRSprint 04: environment/provider status on the dashboard overview", () => {
    it("includes the injected environment status verbatim for a Platform Admin caller", async () => {
      ctx.environmentStatus.status = { ...ctx.environmentStatus.status, appEnv: "staging", database: "configured" };
      const overview = await ctx.adminService.getDashboardOverview("platform_admin");
      expect(overview.environmentStatus).toEqual(ctx.environmentStatus.status);
    });

    it("never leaks past requireAdmin — a member gets ForbiddenError before any status is computed", async () => {
      await expect(ctx.adminService.getDashboardOverview("member")).rejects.toThrow(ForbiddenError);
    });
  });
});
