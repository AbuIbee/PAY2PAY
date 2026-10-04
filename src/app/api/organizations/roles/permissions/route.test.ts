import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createTestOrganizationAuditedMutations } from "@/lib/organizations/organizationAuditedMutationsTestFakes";
import { createRolePermissionsDeleteHandler, createRolePermissionsPostHandler } from "./route";

describe("/api/organizations/roles/permissions", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let mutationsCtx: ReturnType<typeof createTestOrganizationAuditedMutations>;
  let organizationId: string;
  let ownerToken: string;
  let roleId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    mutationsCtx = createTestOrganizationAuditedMutations(orgCtx.roles, orgCtx.staffMembers, orgCtx.invitations);

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

    const org = await orgCtx.businessProfiles.insert({
      ownerUserId: owner.user.id,
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    orgCtx.staffMembers.seed({ businessProfileId: organizationId, userId: owner.user.id, role: "OWNER" });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
    const role = await orgCtx.roleService.createRole({ organizationId, displayName: "Bookkeeper", description: null, permissions: [] });
    roleId = role.id;
  });

  function postHandler() {
    return withErrorHandling("test", createRolePermissionsPostHandler(authCtx.authService, orgCtx.permissions, mutationsCtx.mutations));
  }
  function deleteHandler() {
    return withErrorHandling("test", createRolePermissionsDeleteHandler(authCtx.authService, orgCtx.permissions, mutationsCtx.mutations));
  }
  function request(body: unknown, method: string) {
    return new NextRequest("http://localhost/api/organizations/roles/permissions", {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie: `p2p_session=${ownerToken}` },
    });
  }

  it("assigns a permission, which takes effect immediately in runtime authorization", async () => {
    const member = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "bookkeeper@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    orgCtx.staffMembers.seed({ businessProfileId: organizationId, userId: member.user.id, role: "VIEWER", roleId });
    expect(await orgCtx.permissions.can(member.user.id, organizationId, "balances.view")).toBe(false);

    const response = await postHandler()(request({ organizationId, roleId, permissionKey: "balances.view", scope: "organization" }, "POST"));
    expect(response.status).toBe(200);
    expect(await orgCtx.permissions.can(member.user.id, organizationId, "balances.view")).toBe(true);
  });

  it("rejects an unknown permission key with 400", async () => {
    const response = await postHandler()(request({ organizationId, roleId, permissionKey: "not.a.real.key", scope: "organization" }, "POST"));
    expect(response.status).toBe(400);
  });

  it("rejects an unsupported scope for a permission with 400", async () => {
    const response = await postHandler()(request({ organizationId, roleId, permissionKey: "balances.view", scope: "assigned" }, "POST"));
    expect(response.status).toBe(400);
  });

  it("refuses to edit a protected role's permissions", async () => {
    const seeded = await orgCtx.roleService.seedDefaultRolesForNewOrganization(organizationId);
    const response = await postHandler()(request({ organizationId, roleId: seeded.ownerRoleId, permissionKey: "integrations.connect", scope: "organization" }, "POST"));
    expect(response.status).toBe(403);
  });

  it("removes a permission from a role", async () => {
    await postHandler()(request({ organizationId, roleId, permissionKey: "balances.view", scope: "organization" }, "POST"));
    const response = await deleteHandler()(request({ organizationId, roleId, permissionKey: "balances.view" }, "DELETE"));
    expect(response.status).toBe(200);
    expect(await orgCtx.roles.listPermissionsForRole(roleId)).toHaveLength(0);
  });

  it("a caller without roles.edit is denied", async () => {
    const viewer = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "viewer@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    orgCtx.staffMembers.seed({ businessProfileId: organizationId, userId: viewer.user.id, role: "VIEWER" });
    const response = await postHandler()(
      new NextRequest("http://localhost/api/organizations/roles/permissions", {
        method: "POST",
        body: JSON.stringify({ organizationId, roleId, permissionKey: "balances.view", scope: "organization" }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${viewer.token}` },
      }),
    );
    expect(response.status).toBe(403);
  });
});
