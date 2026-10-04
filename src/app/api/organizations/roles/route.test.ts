import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createTestOrganizationAuditedMutations } from "@/lib/organizations/organizationAuditedMutationsTestFakes";
import { createRolesDeleteHandler, createRolesGetHandler, createRolesPatchHandler, createRolesPostHandler } from "./route";

describe("/api/organizations/roles", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let mutationsCtx: ReturnType<typeof createTestOrganizationAuditedMutations>;
  let organizationId: string;
  let ownerToken: string;
  let viewerToken: string;

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
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: owner.user.id, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });

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
    viewerToken = viewer.token;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: viewer.user.id, role: "VIEWER", customRoleId: null, isAuthorizedRepresentative: false });
    // "Final RBAC Authorization Cutover": no authorization-time self-healing — the explicit migration
    // step is what gives these legacy-role-seeded memberships a resolvable role_id at all.
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
  });

  function getHandler() {
    return withErrorHandling("test", createRolesGetHandler(authCtx.authService, orgCtx.permissions, orgCtx.roleService, orgCtx.roles));
  }
  function postHandler() {
    return withErrorHandling("test", createRolesPostHandler(authCtx.authService, orgCtx.permissions, mutationsCtx.mutations));
  }
  function patchHandler() {
    return withErrorHandling("test", createRolesPatchHandler(authCtx.authService, orgCtx.permissions, orgCtx.roleService, mutationsCtx.mutations));
  }
  function deleteHandler() {
    return withErrorHandling("test", createRolesDeleteHandler(authCtx.authService, orgCtx.permissions, orgCtx.roleService, new AuditService(new InMemoryAuditEventRepository())));
  }

  function jsonRequest(body: unknown, token: string, method = "POST") {
    return new NextRequest(`http://localhost/api/organizations/roles`, {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
    });
  }

  it("an OWNER (roles.create) can create an ordinary role with valid permissions", async () => {
    const response = await postHandler()(
      jsonRequest({ organizationId, displayName: "Bookkeeper", description: "Handles balances.", permissions: [{ permissionKey: "balances.view", scope: "organization" }] }, ownerToken),
    );
    expect(response.status).toBe(201);
  });

  it("a VIEWER (no roles.create) is denied creating a role", async () => {
    const response = await postHandler()(jsonRequest({ organizationId, displayName: "Bookkeeper", permissions: [] }, viewerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unknown permission key with 400", async () => {
    const response = await postHandler()(jsonRequest({ organizationId, displayName: "Bookkeeper", permissions: [{ permissionKey: "not.a.real.permission", scope: "organization" }] }, ownerToken));
    expect(response.status).toBe(400);
  });

  it("cannot set is_owner_role/is_protected through ordinary role creation (not accepted as input at all)", async () => {
    const response = await postHandler()(
      jsonRequest({ organizationId, displayName: "Fake Owner", permissions: [], isOwnerRole: true, isProtected: true }, ownerToken),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    const roles = await orgCtx.roles.listRolesForOrganization(organizationId);
    const created = roles.find((r) => r.id === body.id)!;
    expect(created.isOwnerRole).toBe(false);
    expect(created.isProtected).toBe(false);
  });

  it("GET lists roles with permissions for an authorized caller (roles.view)", async () => {
    await postHandler()(jsonRequest({ organizationId, displayName: "Bookkeeper", permissions: [{ permissionKey: "balances.view", scope: "organization" }] }, ownerToken));
    const response = await getHandler()(new NextRequest(`http://localhost/api/organizations/roles?organizationId=${organizationId}`, { headers: { cookie: `p2p_session=${ownerToken}` } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { roles: Array<{ displayName: string; permissions: Array<{ permissionKey: string }> }> };
    const bookkeeper = body.roles.find((r) => r.displayName === "Bookkeeper")!;
    expect(bookkeeper.permissions.map((p) => p.permissionKey)).toEqual(["balances.view"]);
  });

  it("renaming a role (roles.edit) never changes its permissions", async () => {
    const created = await postHandler()(jsonRequest({ organizationId, displayName: "Bookkeeper", permissions: [{ permissionKey: "balances.view", scope: "organization" }] }, ownerToken));
    const { id: roleId } = (await created.json()) as { id: string };

    const response = await patchHandler()(jsonRequest({ organizationId, roleId, displayName: "Senior Bookkeeper" }, ownerToken, "PATCH"));
    expect(response.status).toBe(200);

    const permissions = await orgCtx.roles.listPermissionsForRole(roleId);
    expect(permissions.map((p) => p.permissionKey)).toEqual(["balances.view"]);
  });

  it("renaming the protected Owner role's display name is allowed, and ownership protection survives it", async () => {
    const seeded = await orgCtx.roleService.seedDefaultRolesForNewOrganization(organizationId);
    const response = await patchHandler()(jsonRequest({ organizationId, roleId: seeded.ownerRoleId, displayName: "President" }, ownerToken, "PATCH"));
    expect(response.status).toBe(200);
    const role = await orgCtx.roles.findRoleById(seeded.ownerRoleId);
    expect(role!.displayName).toBe("President");
    expect(role!.isOwnerRole).toBe(true);
    expect(role!.isProtected).toBe(true);
  });

  it("deletes an unused ordinary role", async () => {
    const created = await postHandler()(jsonRequest({ organizationId, displayName: "Bookkeeper", permissions: [] }, ownerToken));
    const { id: roleId } = (await created.json()) as { id: string };
    const response = await deleteHandler()(jsonRequest({ organizationId, roleId }, ownerToken, "DELETE"));
    expect(response.status).toBe(200);
    expect(await orgCtx.roles.findRoleById(roleId)).toBeNull();
  });

  it("refuses to delete a role with active members unless a reassignment target is supplied, then succeeds with one", async () => {
    const roleResponse = await postHandler()(jsonRequest({ organizationId, displayName: "Bookkeeper", permissions: [] }, ownerToken));
    const { id: roleId } = (await roleResponse.json()) as { id: string };
    const otherRoleResponse = await postHandler()(jsonRequest({ organizationId, displayName: "Other", permissions: [] }, ownerToken));
    const { id: otherRoleId } = (await otherRoleResponse.json()) as { id: string };

    // InMemoryOrganizationRoleRepository tracks membership/invitation assignment via its own
    // dedicated test hooks, deliberately decoupled from BusinessStaffMemberRepository (see its own
    // doc comment) — mirrors organizationRoleService.test.ts's identical usage.
    orgCtx.roles.activeMembersByRole.set(roleId, new Set(["member-1"]));

    const withoutReassign = await deleteHandler()(jsonRequest({ organizationId, roleId }, ownerToken, "DELETE"));
    expect(withoutReassign.status).toBe(400);

    const withReassign = await deleteHandler()(jsonRequest({ organizationId, roleId, reassignToRoleId: otherRoleId }, ownerToken, "DELETE"));
    expect(withReassign.status).toBe(200);
    expect(await orgCtx.roles.findRoleById(roleId)).toBeNull();
  });

  it("the protected Owner role cannot be deleted", async () => {
    const seeded = await orgCtx.roleService.seedDefaultRolesForNewOrganization(organizationId);
    const response = await deleteHandler()(jsonRequest({ organizationId, roleId: seeded.ownerRoleId }, ownerToken, "DELETE"));
    expect(response.status).toBe(403);
  });

  it("a role in a DIFFERENT organization cannot be edited through this organization's own roleId lookup", async () => {
    const otherOrg = await orgCtx.businessProfiles.insert({ ownerUserId: "other-owner", legalBusinessName: "Other Co", displayName: "Other Co", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    const otherRole = await orgCtx.roleService.createRole({ organizationId: otherOrg.id, displayName: "Other Role", description: null, permissions: [] });
    const response = await patchHandler()(jsonRequest({ organizationId, roleId: otherRole.id, displayName: "Hijacked" }, ownerToken, "PATCH"));
    expect(response.status).toBe(400);
  });
});
