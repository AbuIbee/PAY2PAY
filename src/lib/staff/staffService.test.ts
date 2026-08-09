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
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: ownerUserId, role: "owner" });
  });

  it("owner permissions: an owner has every capability, including manage_staff", async () => {
    const owner = await ctx.staffMembers.findActiveByBusinessAndUser(BUSINESS_A, ownerUserId);
    expect(owner).not.toBeNull();
    expect(await ctx.staffService.hasCapability(owner!, "manage_staff")).toBe(true);
    expect(await ctx.staffService.hasCapability(owner!, "forgive_principal")).toBe(true);
    await expect(
      ctx.staffService.requireCapability(BUSINESS_A, ownerUserId, "manage_staff"),
    ).resolves.toMatchObject({ role: "owner" });
  });

  it("manager permissions: has day-to-day capabilities but not manage_staff or forgive_principal", async () => {
    const managerUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: managerUserId, role: "manager" });

    await expect(
      ctx.staffService.requireCapability(BUSINESS_A, managerUserId, "create_agreement"),
    ).resolves.toBeDefined();
    await expect(ctx.staffService.requireCapability(BUSINESS_A, managerUserId, "manage_staff")).rejects.toThrow(
      ForbiddenError,
    );
    await expect(ctx.staffService.requireCapability(BUSINESS_A, managerUserId, "forgive_principal")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("viewer denial: accountant_viewer can view/export but is denied create_agreement", async () => {
    const viewerUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: viewerUserId, role: "accountant_viewer" });

    await expect(ctx.staffService.requireCapability(BUSINESS_A, viewerUserId, "view_reports")).resolves.toBeDefined();
    await expect(ctx.staffService.requireCapability(BUSINESS_A, viewerUserId, "create_agreement")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("custom permission: a custom role grants exactly its own permission set, nothing more", async () => {
    const customRole = await ctx.customRoles.insert({
      businessProfileId: BUSINESS_A,
      name: "Settlement Reviewer",
      permissions: ["approve_agreement", "view_reports"],
    });
    const customUserId = randomUUID();
    ctx.staffMembers.seed({
      businessProfileId: BUSINESS_A,
      userId: customUserId,
      role: "custom",
      customRoleId: customRole.id,
    });

    await expect(ctx.staffService.requireCapability(BUSINESS_A, customUserId, "approve_agreement")).resolves.toBeDefined();
    await expect(ctx.staffService.requireCapability(BUSINESS_A, customUserId, "view_reports")).resolves.toBeDefined();
    await expect(ctx.staffService.requireCapability(BUSINESS_A, customUserId, "manage_staff")).rejects.toThrow(
      ForbiddenError,
    );
    await expect(ctx.staffService.requireCapability(BUSINESS_A, customUserId, "forgive_principal")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("privilege escalation attempt: a manager cannot invite/assign the owner role to anyone", async () => {
    const managerUserId = randomUUID();
    ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: managerUserId, role: "manager" });
    ctx.userEmails.set(managerUserId, "manager@example.com");

    await expect(
      ctx.staffService.inviteStaff({
        businessProfileId: BUSINESS_A,
        invitedByUserId: managerUserId,
        email: "wannabe-owner@example.com",
        role: "owner",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("privilege escalation attempt: a manager cannot promote an existing staff member to owner", async () => {
    // A non-owner who nonetheless holds manage_staff (via a custom role) —
    // isolates the privilege-escalation guard from the plain capability gate.
    const manageStaffRole = await ctx.customRoles.insert({
      businessProfileId: BUSINESS_A,
      name: "Staff Manager (non-owner)",
      permissions: ["manage_staff"],
    });
    const managerUserId = randomUUID();
    ctx.staffMembers.seed({
      businessProfileId: BUSINESS_A,
      userId: managerUserId,
      role: "custom",
      customRoleId: manageStaffRole.id,
    });
    const target = ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: randomUUID(), role: "receivables_staff" });
    await grantStepUp(ctx, managerUserId, "session-1");

    await expect(
      ctx.staffService.updateStaffRole({
        businessProfileId: BUSINESS_A,
        actingUserId: managerUserId,
        actingSessionId: "session-1",
        targetStaffId: target.id,
        newRole: "owner",
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
        newRole: "manager",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("removed staff: a removed staff member immediately loses access and their sessions are revoked", async () => {
    const managerUserId = randomUUID();
    const target = ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: managerUserId, role: "manager" });
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
    const target = ctx.staffMembers.seed({ businessProfileId: BUSINESS_A, userId: anotherOwnerUserId, role: "owner" });

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
    const targetInB = ctx.staffMembers.seed({ businessProfileId: BUSINESS_B, userId: businessBOwnerId, role: "manager" });
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
        newRole: "manager",
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
      role: "manager",
    });
    expect(ctx.emailSender.sent).toHaveLength(1);
    const rawToken = ctx.emailSender.lastTokenFor("new-hire@example.com");
    expect(rawToken).toBeDefined();

    const member = await ctx.staffService.acceptInvitation(rawToken!, acceptingUserId);
    expect(member.role).toBe("manager");
    expect(member.businessProfileId).toBe(BUSINESS_A);
    void invitation;
  });

  it("staff invitation: acceptance is rejected if the accepting account's email doesn't match the invited email", async () => {
    const wrongUserId = randomUUID();
    ctx.userEmails.set(wrongUserId, "someone-else@example.com");

    await ctx.staffService.inviteStaff({
      businessProfileId: BUSINESS_A,
      invitedByUserId: ownerUserId,
      email: "invitee@example.com",
      role: "manager",
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
      role: "manager",
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
      role: "manager",
    });
    await expect(
      ctx.staffService.inviteStaff({
        businessProfileId: BUSINESS_A,
        invitedByUserId: ownerUserId,
        email: "dup@example.com",
        role: "manager",
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
