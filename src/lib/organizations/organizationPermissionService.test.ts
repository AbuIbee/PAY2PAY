import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestOrganizationPermissionService } from "./testFakes";

describe("OrganizationPermissionService (Custom RBAC Runtime Cutover)", () => {
  let ctx: ReturnType<typeof createTestOrganizationPermissionService>;
  let organizationId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    ctx = createTestOrganizationPermissionService();
    const org = await ctx.businessProfiles.insert({
      ownerUserId: "owner-user",
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    ownerUserId = "owner-user";
  });

  it("a custom role's permission grants access", async () => {
    const role = await ctx.roleService.createRole({ organizationId, displayName: "Bookkeeper", description: null, permissions: [{ permissionKey: "balances.view", scope: "organization" }] });
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "bookkeeper", role: "VIEWER", roleId: role.id });
    expect(await ctx.permissions.can(member.userId, organizationId, "balances.view")).toBe(true);
  });

  it("missing permission denies access", async () => {
    const role = await ctx.roleService.createRole({ organizationId, displayName: "Bookkeeper", description: null, permissions: [{ permissionKey: "balances.view", scope: "organization" }] });
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "bookkeeper", role: "VIEWER", roleId: role.id });
    expect(await ctx.permissions.can(member.userId, organizationId, "integrations.connect")).toBe(false);
  });

  it("role DISPLAY NAME does not grant access — a role named 'Manager' with no permissions grants nothing", async () => {
    const role = await ctx.roleService.createRole({ organizationId, displayName: "Manager", description: null, permissions: [] });
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "faux-manager", role: "VIEWER", roleId: role.id });
    expect(await ctx.permissions.can(member.userId, organizationId, "agreements.view")).toBe(false);
  });

  it("renamed role retains its permissions and continues to authorize", async () => {
    const role = await ctx.roleService.createRole({ organizationId, displayName: "Bookkeeper", description: null, permissions: [{ permissionKey: "balances.view", scope: "organization" }] });
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "bookkeeper", role: "VIEWER", roleId: role.id });
    await ctx.roleService.renameRole(organizationId, role.id, "Senior Bookkeeper");
    expect(await ctx.permissions.can(member.userId, organizationId, "balances.view")).toBe(true);
  });

  it("a role with the same display name in a DIFFERENT organization has no effect on this one", async () => {
    const otherOrg = await ctx.businessProfiles.insert({ ownerUserId: "other-owner", legalBusinessName: "Other Co", displayName: "Other Co", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    await ctx.roleService.createRole({ organizationId: otherOrg.id, displayName: "Bookkeeper", description: null, permissions: [{ permissionKey: "integrations.connect", scope: "organization" }] });
    const role = await ctx.roleService.createRole({ organizationId, displayName: "Bookkeeper", description: null, permissions: [{ permissionKey: "balances.view", scope: "organization" }] });
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "bookkeeper", role: "VIEWER", roleId: role.id });
    // Only this organization's own "Bookkeeper" permissions apply — never the other org's role of the same name.
    expect(await ctx.permissions.can(member.userId, organizationId, "integrations.connect")).toBe(false);
    expect(await ctx.permissions.can(member.userId, organizationId, "balances.view")).toBe(true);
  });

  it("a permission change takes effect in runtime authorization immediately", async () => {
    const role = await ctx.roleService.createRole({ organizationId, displayName: "Bookkeeper", description: null, permissions: [] });
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "bookkeeper", role: "VIEWER", roleId: role.id });
    expect(await ctx.permissions.can(member.userId, organizationId, "balances.view")).toBe(false);
    await ctx.roleService.assignPermission(organizationId, role.id, "balances.view", "organization");
    expect(await ctx.permissions.can(member.userId, organizationId, "balances.view")).toBe(true);
  });

  it("an inactive (removed) membership is denied", async () => {
    const role = await ctx.roleService.createRole({ organizationId, displayName: "Bookkeeper", description: null, permissions: [{ permissionKey: "balances.view", scope: "organization" }] });
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "bookkeeper", role: "VIEWER", roleId: role.id });
    await ctx.staffMembers.markRemoved(member.id, new Date());
    expect(await ctx.permissions.can(member.userId, organizationId, "balances.view")).toBe(false);
  });

  it("a user with no membership in this organization is denied (cross-tenant)", async () => {
    expect(await ctx.permissions.can("stranger", organizationId, "dashboard.view")).toBe(false);
  });

  it("a role_id belonging to a DIFFERENT organization than the membership cannot authorize (cross-tenant role)", async () => {
    const otherOrg = await ctx.businessProfiles.insert({ ownerUserId: "other-owner", legalBusinessName: "Other Co", displayName: "Other Co", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    const otherOrgRole = await ctx.roleService.createRole({ organizationId: otherOrg.id, displayName: "Full Access", description: null, permissions: [{ permissionKey: "integrations.connect", scope: "organization" }] });
    // Data-corruption scenario: a membership in `organizationId` pointing at a role owned by `otherOrg`.
    const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "confused-member", role: "VIEWER", roleId: otherOrgRole.id });
    expect(await ctx.permissions.can(member.userId, organizationId, "integrations.connect")).toBe(false);
  });

  describe("no authorization-time self-healing (Final RBAC Authorization Cutover)", () => {
    it("a legacy OWNER membership with no role_id yet is DENIED every permission — role_id missing means deny, never a legacy-enum fallback", async () => {
      const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: ownerUserId, role: "OWNER" });
      expect(await ctx.permissions.can(member.userId, organizationId, "dashboard.view")).toBe(false);
      expect(await ctx.permissions.isProtectedOwner(member.userId, organizationId)).toBe(false);
    });

    it("can()/require() never write role_id — calling them on an unmigrated membership leaves role_id null afterward", async () => {
      const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "viewer-user", role: "VIEWER" });
      await ctx.permissions.can(member.userId, organizationId, "dashboard.view");
      await ctx.permissions.isProtectedOwner(member.userId, organizationId);
      await expect(ctx.permissions.require(member.userId, organizationId, "dashboard.view")).rejects.toThrow();
      const reread = await ctx.staffMembers.findActiveByBusinessAndUser(organizationId, "viewer-user");
      expect(reread!.roleId).toBeNull();
    });

    it("after the EXPLICIT, separate migration/backfill runs, the same legacy OWNER membership is correctly granted every permission", async () => {
      ctx.staffMembers.seed({ businessProfileId: organizationId, userId: ownerUserId, role: "OWNER" });
      await ctx.legacyMigration.migrateOrganization(organizationId);
      expect(await ctx.permissions.can(ownerUserId, organizationId, "integrations.connect")).toBe(true);
      expect(await ctx.permissions.can(ownerUserId, organizationId, "subscription.manage")).toBe(true);
      expect(await ctx.permissions.isProtectedOwner(ownerUserId, organizationId)).toBe(true);
    });

    it("after explicit migration, a legacy VIEWER membership retains ordinary read access but no mutation capability", async () => {
      ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "viewer-user", role: "VIEWER" });
      await ctx.legacyMigration.migrateOrganization(organizationId);
      expect(await ctx.permissions.can("viewer-user", organizationId, "dashboard.view")).toBe(true);
      expect(await ctx.permissions.can("viewer-user", organizationId, "balances.view")).toBe(true);
      expect(await ctx.permissions.can("viewer-user", organizationId, "balances.create")).toBe(false);
      expect(await ctx.permissions.can("viewer-user", organizationId, "integrations.connect")).toBe(false);
    });

    it("after explicit migration, a legacy FINANCE_ADMIN membership retains its full equivalent permission set, and AR_AGENT does NOT gain organization agreement authority", async () => {
      ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "finance-user", role: "FINANCE_ADMIN" });
      ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "agent-user", role: "AR_AGENT" });
      await ctx.legacyMigration.migrateOrganization(organizationId);
      expect(await ctx.permissions.can("finance-user", organizationId, "agreements.create")).toBe(true);
      expect(await ctx.permissions.can("finance-user", organizationId, "members.invite")).toBe(true);
      expect(await ctx.permissions.can("finance-user", organizationId, "subscription.manage")).toBe(false);
      // AR_AGENT historically never held manage_agreements — must not receive agreements.create merely
      // because it held the separate, party-level create_agreement capability.
      expect(await ctx.permissions.can("agent-user", organizationId, "agreements.create")).toBe(false);
    });
  });

  describe("authorization is read-only (Final RBAC Authorization Cutover, Step 4)", () => {
    it("can()/require()/isProtectedOwner() never call any membership-update or role-assignment write method, even for an unmigrated membership", async () => {
      const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "viewer-user", role: "VIEWER" });
      const setRoleIdSpy = vi.spyOn(ctx.staffMembers, "setRoleId");
      const insertSpy = vi.spyOn(ctx.staffMembers, "insert");
      const updateRoleSpy = vi.spyOn(ctx.staffMembers, "updateRole");
      const markRemovedSpy = vi.spyOn(ctx.staffMembers, "markRemoved");
      const insertRoleSpy = vi.spyOn(ctx.roles, "insertRole");
      const insertPermissionSpy = vi.spyOn(ctx.roles, "insertPermission");

      await ctx.permissions.can(member.userId, organizationId, "dashboard.view");
      await ctx.permissions.isProtectedOwner(member.userId, organizationId);
      await ctx.permissions.require(member.userId, organizationId, "dashboard.view").catch(() => {});

      expect(setRoleIdSpy).not.toHaveBeenCalled();
      expect(insertSpy).not.toHaveBeenCalled();
      expect(updateRoleSpy).not.toHaveBeenCalled();
      expect(markRemovedSpy).not.toHaveBeenCalled();
      expect(insertRoleSpy).not.toHaveBeenCalled();
      expect(insertPermissionSpy).not.toHaveBeenCalled();
    });
  });

  describe("protected Owner", () => {
    it("isProtectedOwner is true for the seeded Owner role, independent of permission set", async () => {
      const ownerRole = await ctx.roleService.seedDefaultRolesForNewOrganization(organizationId);
      const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "owner-member", role: "OWNER", roleId: ownerRole.ownerRoleId });
      expect(await ctx.permissions.isProtectedOwner(member.userId, organizationId)).toBe(true);
    });

    it("an ordinary role granted every permission in the catalog is still NOT the protected owner", async () => {
      const { ownerPermissionKeys } = await import("./defaultRoleTemplates");
      const allPermissions = ownerPermissionKeys().map((key) => ({ permissionKey: key, scope: "organization" as const }));
      const role = await ctx.roleService.createRole({ organizationId, displayName: "All Access", description: null, permissions: allPermissions });
      const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "all-access-user", role: "VIEWER", roleId: role.id });
      expect(await ctx.permissions.can(member.userId, organizationId, "organization.edit")).toBe(true);
      expect(await ctx.permissions.isProtectedOwner(member.userId, organizationId)).toBe(false);
    });

    it("renaming the Owner role's display name does not change its protected status", async () => {
      const seeded = await ctx.roleService.seedDefaultRolesForNewOrganization(organizationId);
      await ctx.roleService.renameRole(organizationId, seeded.ownerRoleId, "President");
      const member = ctx.staffMembers.seed({ businessProfileId: organizationId, userId: "owner-member", role: "OWNER", roleId: seeded.ownerRoleId });
      expect(await ctx.permissions.isProtectedOwner(member.userId, organizationId)).toBe(true);
      expect(await ctx.permissions.can(member.userId, organizationId, "integrations.connect")).toBe(true);
    });
  });
});
