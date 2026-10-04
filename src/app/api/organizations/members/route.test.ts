import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createTestOrganizationAuditedMutations } from "@/lib/organizations/organizationAuditedMutationsTestFakes";
import { createMembersDeleteHandler, createMembersPatchHandler } from "./route";

describe("/api/organizations/members", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let ctx: ReturnType<typeof createTestOrganizationPermissionService>;
  let mutationsCtx: ReturnType<typeof createTestOrganizationAuditedMutations>;
  let organizationId: string;
  let ownerToken: string;
  let managerRoleId: string;
  let ownerRoleId: string;
  let managerMembershipId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    ctx = createTestOrganizationPermissionService();
    mutationsCtx = createTestOrganizationAuditedMutations(ctx.roles, ctx.staffMembers, ctx.invitations);

    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;

    const org = await ctx.businessProfiles.insert({
      ownerUserId: owner.user.id,
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    const seeded = await ctx.roleService.seedDefaultRolesForNewOrganization(organizationId);
    ownerRoleId = seeded.ownerRoleId;
    managerRoleId = seeded.managerRoleId;
    ctx.staffMembers.seed({ businessProfileId: organizationId, userId: owner.user.id, role: "OWNER", roleId: ownerRoleId });

    const manager = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "manager@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const membership = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: manager.user.id, role: "VIEWER", roleId: managerRoleId });
    managerMembershipId = membership.id;
  });

  function patchHandler() {
    return withErrorHandling("test", createMembersPatchHandler(authCtx.authService, ctx.permissions, mutationsCtx.mutations));
  }
  function deleteHandler() {
    return withErrorHandling("test", createMembersDeleteHandler(authCtx.authService, ctx.permissions, mutationsCtx.mutations));
  }
  function request(body: unknown, token: string, method: string) {
    return new NextRequest("http://localhost/api/organizations/members", {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
    });
  }

  it("an OWNER (roles.assign) can change a team member's role", async () => {
    const response = await patchHandler()(request({ organizationId, memberId: managerMembershipId, roleId: ownerRoleId }, ownerToken, "PATCH"));
    expect(response.status).toBe(200);
    const updated = await ctx.staffMembers.findById(managerMembershipId);
    expect(updated!.roleId).toBe(ownerRoleId);
  });

  it("rejects a roleId from a different organization", async () => {
    const otherOrg = await ctx.businessProfiles.insert({ ownerUserId: "other-owner", legalBusinessName: "Other Co", displayName: "Other Co", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    const otherRole = await ctx.roleService.createRole({ organizationId: otherOrg.id, displayName: "Other", description: null, permissions: [] });
    const response = await patchHandler()(request({ organizationId, memberId: managerMembershipId, roleId: otherRole.id }, ownerToken, "PATCH"));
    expect(response.status).toBe(400);
  });

  it("an OWNER (members.remove) can remove a team member", async () => {
    const response = await deleteHandler()(request({ organizationId, memberId: managerMembershipId }, ownerToken, "DELETE"));
    expect(response.status).toBe(200);
    expect((await ctx.staffMembers.findById(managerMembershipId))!.removedAt).not.toBeNull();
  });

  it("the sole Owner cannot be removed (blocked, whether by the self-removal guard or the final-Owner guard)", async () => {
    const owner = await authCtx.authService.validateSession(ownerToken);
    const ownerMembershipRecord = await ctx.staffMembers.findActiveByBusinessAndUser(organizationId, owner!.user.id);
    const response = await deleteHandler()(request({ organizationId, memberId: ownerMembershipRecord!.id }, ownerToken, "DELETE"));
    expect(response.status).toBe(403);
  });

  it("the final Owner specifically cannot be removed even by a different authorized caller", async () => {
    await ctx.roleService.assignPermission(organizationId, managerRoleId, "members.remove", "organization");
    const secondManager = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "manager2@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ctx.staffMembers.seed({ businessProfileId: organizationId, userId: secondManager.user.id, role: "VIEWER", roleId: managerRoleId });
    const owner = await authCtx.authService.validateSession(ownerToken);
    const ownerMembershipRecord = await ctx.staffMembers.findActiveByBusinessAndUser(organizationId, owner!.user.id);
    const response = await deleteHandler()(request({ organizationId, memberId: ownerMembershipRecord!.id }, secondManager.token, "DELETE"));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await patchHandler()(
      new NextRequest("http://localhost/api/organizations/members", {
        method: "PATCH",
        body: JSON.stringify({ organizationId, memberId: managerMembershipId, roleId: ownerRoleId }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
