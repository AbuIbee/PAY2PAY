import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { hashOpaqueToken } from "@/lib/auth/token";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestStaffService, grantStepUp } from "./testFakes";

const BUSINESS_A = randomUUID();
const BUSINESS_B = randomUUID();

describe("StaffService", () => {
  let ctx: ReturnType<typeof createTestStaffService>;
  let ownerUserId: string;

  beforeEach(() => {
    ctx = createTestStaffService();
    ownerUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: ownerUserId, role: "OWNER" });
  });

  it("owner permissions: an owner has every capability, including manage_staff", async () => {
    const owner = await ctx.staffMembers.findActiveByBusinessAndUser(BUSINESS_A, ownerUserId);
    expect(owner).not.toBeNull();
    expect(await ctx.staffService.hasCapability(owner!, "manage_staff")).toBe(true);
    expect(await ctx.staffService.hasCapability(owner!, "forgive_principal")).toBe(true);
    await expect(
      ctx.staffService.requireCapability(BUSINESS_A, ownerUserId, "manage_staff"),
    ).resolves.toMatchObject({ role: "OWNER" });
  });

  describe("countActiveStaff — dashboard consistency fix", () => {
    it("returns the correct count even for a caller with no business_staff_member row of their own (a real business owner, in practice) — unlike listStaff, this never requires active-staff authorization", async () => {
      const freshBusinessId = randomUUID();
      // Deliberately no seeded staff row for anyone on this business — mirrors a real business
      // created via BusinessProfileService.createBusinessProfile, which never seeds an owner row.
      expect(await ctx.staffService.countActiveStaff(freshBusinessId)).toBe(0);
    });

    it("counts every active staff member accurately once some exist", async () => {
      const memberUserId = randomUUID();
      ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: memberUserId, role: "FINANCE_ADMIN" });
      // BUSINESS_A already has the owner seeded in beforeEach, plus this new finance admin = 2.
      expect(await ctx.staffService.countActiveStaff(BUSINESS_A)).toBe(2);
    });

    it("by contrast, listStaff DOES still require active-staff authorization (unchanged) — proves countActiveStaff is a deliberate, narrow exception, not a broader authorization regression", async () => {
      const nonStaffUserId = randomUUID();
      await expect(ctx.staffService.listStaff(BUSINESS_A, nonStaffUserId)).rejects.toThrow(ForbiddenError);
    });
  });

  it("AR_MANAGER permissions: has day-to-day capabilities but not manage_staff or forgive_principal", async () => {
    const arManagerUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: arManagerUserId, role: "AR_MANAGER" });

    await expect(
      ctx.staffService.requireCapability(BUSINESS_A, arManagerUserId, "create_agreement"),
    ).resolves.toBeDefined();
    await expect(ctx.staffService.requireCapability(BUSINESS_A, arManagerUserId, "manage_staff")).rejects.toThrow(
      ForbiddenError,
    );
    await expect(ctx.staffService.requireCapability(BUSINESS_A, arManagerUserId, "forgive_principal")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("VIEWER denial: VIEWER holds no capability at all — read access comes from plain active membership, never a capability grant", async () => {
    const viewerUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: viewerUserId, role: "VIEWER" });

    const viewer = await ctx.staffMembers.findActiveByBusinessAndUser(BUSINESS_A, viewerUserId);
    expect(viewer).not.toBeNull();
    await expect(ctx.staffService.requireCapability(BUSINESS_A, viewerUserId, "view_reports")).rejects.toThrow(
      ForbiddenError,
    );
    await expect(ctx.staffService.requireCapability(BUSINESS_A, viewerUserId, "create_agreement")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("custom roles deferred: \"custom\" is no longer an assignable organization role — a stale/legacy role string must be rejected, not silently coerced", async () => {
    const customRole = await ctx.customRoles.insert({
      businessProfileId: BUSINESS_A,
      name: "Settlement Reviewer",
      permissions: ["approve_agreement", "view_reports"],
    });
    const legacyInvite = {
      businessProfileId: BUSINESS_A,
      invitedByUserId: ownerUserId,
      email: "custom-candidate@example.com",
      role: "custom",
      customRoleId: customRole.id,
    } as unknown as Parameters<typeof ctx.staffService.inviteStaff>[0];

    await expect(ctx.staffService.inviteStaff(legacyInvite)).rejects.toThrow(ValidationError);
  });

  it("privilege escalation attempt: a FINANCE_ADMIN cannot invite/assign the OWNER role to anyone", async () => {
    const financeAdminUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: financeAdminUserId, role: "FINANCE_ADMIN" });
    ctx.userEmails.set(financeAdminUserId, "finance-admin@example.com");

    await expect(
      ctx.staffService.inviteStaff({
        businessProfileId: BUSINESS_A,
        invitedByUserId: financeAdminUserId,
        email: "wannabe-owner@example.com",
        role: "OWNER",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("privilege escalation attempt: a FINANCE_ADMIN cannot promote an existing staff member to OWNER, even though FINANCE_ADMIN already holds manage_staff", async () => {
    // FINANCE_ADMIN is a non-owner role that nonetheless holds manage_staff by default — this
    // isolates the owner-escalation guard from the plain capability gate (replaces the former
    // custom-role workaround now that custom-role assignment is deferred/unavailable).
    const financeAdminUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: financeAdminUserId, role: "FINANCE_ADMIN" });
    const target = ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: randomUUID(), role: "AR_MANAGER" });
    await grantStepUp(ctx, financeAdminUserId, "session-1");

    await expect(
      ctx.staffService.updateStaffRole({
        businessProfileId: BUSINESS_A,
        actingUserId: financeAdminUserId,
        actingSessionId: "session-1",
        targetStaffId: target.id,
        newRole: "OWNER",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("staff self-promotion attempt: an owner cannot change their own role through updateStaffRole", async () => {
    await grantStepUp(ctx, ownerUserId, "session-1");
    const self = await ctx.staffMembers.findActiveByBusinessAndUser(BUSINESS_A, ownerUserId);

    await expect(
      ctx.staffService.updateStaffRole({
        businessProfileId: BUSINESS_A,
        actingUserId: ownerUserId,
        actingSessionId: "session-1",
        targetStaffId: self!.id,
        newRole: "FINANCE_ADMIN",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("staff self-promotion attempt: a FINANCE_ADMIN cannot promote themselves to OWNER through updateStaffRole (the self-change guard fires regardless of the requested role)", async () => {
    const financeAdminUserId = randomUUID();
    const financeAdmin = ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: financeAdminUserId, role: "FINANCE_ADMIN" });
    await grantStepUp(ctx, financeAdminUserId, "session-1");

    await expect(
      ctx.staffService.updateStaffRole({
        businessProfileId: BUSINESS_A,
        actingUserId: financeAdminUserId,
        actingSessionId: "session-1",
        targetStaffId: financeAdmin.id,
        newRole: "OWNER",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("duplicate membership rejected: a user who already holds an active membership cannot gain a second one by accepting another invitation to the same business", async () => {
    const existingMemberUserId = randomUUID();
    ctx.userEmails.set(existingMemberUserId, "already-staff@example.com");
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: existingMemberUserId, role: "AR_MANAGER" });

    await ctx.staffService.inviteStaff({
      businessProfileId: BUSINESS_A,
      invitedByUserId: ownerUserId,
      email: "already-staff@example.com",
      role: "FINANCE_ADMIN",
    });
    const rawToken = ctx.emailSender.lastTokenFor("already-staff@example.com")!;

    await expect(ctx.staffService.acceptInvitation(rawToken, existingMemberUserId)).rejects.toThrow(ConflictError);
  });

  it("removed staff: a removed staff member immediately loses access and their sessions are revoked", async () => {
    const managerUserId = randomUUID();
    // AR_MANAGER, not FINANCE_ADMIN — FINANCE_ADMIN now holds manage_staff (a HIGH_RISK_CAPABILITY)
    // by default, which would require a fresh step-up to remove (see the dedicated step-up test
    // below); this test is specifically about the low-risk removal path.
    const target = ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: managerUserId, role: "AR_MANAGER" });
    const session = await ctx.sessions.insert({
      userId: managerUserId,
      sessionTokenHash: "hash-1",
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
    });

    await ctx.staffService.removeStaff({
      businessProfileId: BUSINESS_A,
      actingUserId: ownerUserId,
      actingSessionId: "owner-session",
      targetStaffId: target.id,
    });

    await expect(ctx.staffService.requireActiveStaff(BUSINESS_A, managerUserId)).rejects.toThrow(ForbiddenError);
    const revokedSession = await ctx.sessions.findByTokenHash("hash-1");
    expect(revokedSession?.revokedAt).not.toBeNull();
    void session;
  });

  it("removed staff: removing a staff member who holds a high-risk capability requires a fresh step-up", async () => {
    const anotherOwnerUserId = randomUUID();
    const target = ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: anotherOwnerUserId, role: "OWNER" });

    // No step-up granted for this session — high-risk removal (owner holds manage_staff) must be rejected.
    await expect(
      ctx.staffService.removeStaff({
        businessProfileId: BUSINESS_A,
        actingUserId: ownerUserId,
        actingSessionId: "no-step-up-session",
        targetStaffId: target.id,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("cross-business access: an owner of business A cannot remove or promote staff belonging to business B", async () => {
    const businessBOwnerId = randomUUID();
    const targetInB = ctx.staffMembers.seed({ businessProfileId: BUSINESS_B, userId: businessBOwnerId, role: "FINANCE_ADMIN" });
    await grantStepUp(ctx, ownerUserId, "session-1");

    await expect(
      ctx.staffService.removeStaff({
        businessProfileId: BUSINESS_A,
        actingUserId: ownerUserId,
        actingSessionId: "session-1",
        targetStaffId: targetInB.id,
      }),
    ).rejects.toThrow(ForbiddenError);

    await expect(
      ctx.staffService.updateStaffRole({
        businessProfileId: BUSINESS_A,
        actingUserId: ownerUserId,
        actingSessionId: "session-1",
        targetStaffId: targetInB.id,
        newRole: "FINANCE_ADMIN",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("cross-business access: a staff member of business A has no active membership in business B", async () => {
    await expect(ctx.staffService.requireActiveStaff(BUSINESS_B, ownerUserId)).rejects.toThrow(ForbiddenError);
  });

  it("staff invitation + acceptance: an invited email can accept and gains the invited role", async () => {
    const acceptingUserId = randomUUID();
    ctx.userEmails.set(acceptingUserId, "new-hire@example.com");

    const invitation = await ctx.staffService.inviteStaff({
      businessProfileId: BUSINESS_A,
      invitedByUserId: ownerUserId,
      email: "New-Hire@Example.com",
      role: "FINANCE_ADMIN",
    });
    expect(ctx.emailSender.sent).toHaveLength(1);
    const rawToken = ctx.emailSender.lastTokenFor("new-hire@example.com");
    expect(rawToken).toBeDefined();

    const member = await ctx.staffService.acceptInvitation(rawToken!, acceptingUserId);
    expect(member.role).toBe("FINANCE_ADMIN");
    expect(member.businessProfileId).toBe(BUSINESS_A);
    void invitation;
  });

  it(
    "PRSprint 03: a business can re-invite and re-accept a previously removed staff member " +
      "(the live schema's uniqueness constraint on business_staff_member used to be a full, not " +
      "partial, index on (business_profile_id, user_id) with no exception for a removed row, which " +
      "would have thrown a live unique-constraint violation on the second acceptInvitation's INSERT " +
      "even though this in-memory fake never modeled that bug — see the migration fix in " +
      "supabase/migrations/20260815092000_prsprint03_integrity_hardening.sql)",
    async () => {
      const formerStaffUserId = randomUUID();
      ctx.userEmails.set(formerStaffUserId, "boomerang@example.com");

      const firstInvitation = await ctx.staffService.inviteStaff({
        businessProfileId: BUSINESS_A,
        invitedByUserId: ownerUserId,
        email: "boomerang@example.com",
        role: "AR_MANAGER", // not FINANCE_ADMIN — removed below without a step-up grant; see the other test's own comment on why.
      });
      const firstToken = ctx.emailSender.lastTokenFor("boomerang@example.com")!;
      const firstMember = await ctx.staffService.acceptInvitation(firstToken, formerStaffUserId);
      void firstInvitation;

      await ctx.staffService.removeStaff({
        businessProfileId: BUSINESS_A,
        actingUserId: ownerUserId,
        actingSessionId: "owner-session-remove",
        targetStaffId: firstMember.id,
      });
      await expect(ctx.staffService.requireActiveStaff(BUSINESS_A, formerStaffUserId)).rejects.toThrow(ForbiddenError);

      // Re-invite the same person to the same business — this is the exact scenario the old full
      // unique index would have blocked at the database layer on the INSERT below.
      await ctx.staffService.inviteStaff({
        businessProfileId: BUSINESS_A,
        invitedByUserId: ownerUserId,
        email: "boomerang@example.com",
        role: "AR_MANAGER",
      });
      const secondToken = ctx.emailSender.lastTokenFor("boomerang@example.com")!;
      const secondMember = await ctx.staffService.acceptInvitation(secondToken, formerStaffUserId);

      expect(secondMember.id).not.toBe(firstMember.id);
      expect(secondMember.role).toBe("AR_MANAGER");
      await expect(ctx.staffService.requireActiveStaff(BUSINESS_A, formerStaffUserId)).resolves.toMatchObject({
        id: secondMember.id,
      });
    },
  );

  it("staff invitation: acceptance is rejected if the accepting account's email doesn't match the invited email", async () => {
    const wrongUserId = randomUUID();
    ctx.userEmails.set(wrongUserId, "someone-else@example.com");

    await ctx.staffService.inviteStaff({
      businessProfileId: BUSINESS_A,
      invitedByUserId: ownerUserId,
      email: "invitee@example.com",
      role: "FINANCE_ADMIN",
    });
    const rawToken = ctx.emailSender.lastTokenFor("invitee@example.com")!;

    await expect(ctx.staffService.acceptInvitation(rawToken, wrongUserId)).rejects.toThrow(ForbiddenError);
  });

  it("invitation expiration: an expired invitation cannot be accepted", async () => {
    const acceptingUserId = randomUUID();
    ctx.userEmails.set(acceptingUserId, "late@example.com");

    await ctx.staffService.inviteStaff({
      businessProfileId: BUSINESS_A,
      invitedByUserId: ownerUserId,
      email: "late@example.com",
      role: "FINANCE_ADMIN",
    });
    const rawToken = ctx.emailSender.lastTokenFor("late@example.com")!;
    // Force expiry directly, rather than waiting out the real 7-day TTL.
    const stored = await ctx.invitations.findByTokenHash(hashOpaqueToken(rawToken));
    stored!.expiresAt = new Date(Date.now() - 1000);

    await expect(ctx.staffService.acceptInvitation(rawToken, acceptingUserId)).rejects.toThrow(ValidationError);
  });

  it("duplicate pending invitation for the same email is rejected", async () => {
    await ctx.staffService.inviteStaff({
      businessProfileId: BUSINESS_A,
      invitedByUserId: ownerUserId,
      email: "dup@example.com",
      role: "FINANCE_ADMIN",
    });
    await expect(
      ctx.staffService.inviteStaff({
        businessProfileId: BUSINESS_A,
        invitedByUserId: ownerUserId,
        email: "dup@example.com",
        role: "FINANCE_ADMIN",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("custom-role edits and staff role changes are audited and require step-up", async () => {
    // No step-up granted — must be rejected even though the owner has manage_staff.
    await expect(
      ctx.staffService.createCustomRole({
        businessProfileId: BUSINESS_A,
        actingUserId: ownerUserId,
        actingSessionId: "no-step-up",
        name: "Ops",
        permissions: ["view_reports"],
      }),
    ).rejects.toThrow(ForbiddenError);

    await grantStepUp(ctx, ownerUserId, "with-step-up");
    const role = await ctx.staffService.createCustomRole({
      businessProfileId: BUSINESS_A,
      actingUserId: ownerUserId,
      actingSessionId: "with-step-up",
      name: "Ops",
      permissions: ["view_reports"],
    });
    expect(role.permissions).toEqual(["view_reports"]);
    expect(ctx.auditRepo.events.map((e) => e.action)).toContain("custom_role_created");
  });
});
