import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { DEFAULT_ROLE_TEMPLATES, ownerPermissionKeys } from "./defaultRoleTemplates";
import { createTestOrganizationRoleService } from "./organizationRoleTestFakes";
import { PERMISSION_CATALOG } from "./permissionCatalog";

describe("OrganizationRoleService", () => {
  let ctx: ReturnType<typeof createTestOrganizationRoleService>;
  const ORG_A = randomUUID();
  const ORG_B = randomUUID();

  beforeEach(() => {
    ctx = createTestOrganizationRoleService();
  });

  describe("seedDefaultRolesForNewOrganization", () => {
    it("creates Owner/Manager/Employee 2/Employee 3 with exactly the specified default permission sets", async () => {
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_A);
      const withPermissions = await ctx.organizationRoleService.listRolesWithPermissions(ORG_A);
      expect(withPermissions).toHaveLength(4);

      const owner = withPermissions.find((r) => r.role.displayName === "Owner")!;
      expect(owner.role.isOwnerRole).toBe(true);
      expect(owner.role.isProtected).toBe(true);
      expect(owner.permissions.map((p) => p.permissionKey).sort()).toEqual(ownerPermissionKeys().slice().sort());
      // Owner receives the COMPLETE catalog, not a hand-maintained subset that could drift.
      expect(owner.permissions).toHaveLength(PERMISSION_CATALOG.length);

      const manager = withPermissions.find((r) => r.role.displayName === "Manager")!;
      expect(manager.role.isOwnerRole).toBe(false);
      expect(manager.role.isProtected).toBe(false);
      expect(manager.permissions.map((p) => p.permissionKey).sort()).toEqual(DEFAULT_ROLE_TEMPLATES.manager.permissionKeys.slice().sort());
      expect(manager.permissions.map((p) => p.permissionKey)).not.toContain("payments.approve");
      expect(manager.permissions.map((p) => p.permissionKey)).not.toContain("members.remove");
      expect(manager.permissions.map((p) => p.permissionKey)).not.toContain("roles.create");
      expect(manager.permissions.map((p) => p.permissionKey)).not.toContain("subscription.manage");
      expect(manager.permissions.map((p) => p.permissionKey)).not.toContain("integrations.connect");

      const employee2 = withPermissions.find((r) => r.role.displayName === "Employee 2")!;
      expect(employee2.permissions.map((p) => p.permissionKey).sort()).toEqual(DEFAULT_ROLE_TEMPLATES.employee2.permissionKeys.slice().sort());

      const employee3 = withPermissions.find((r) => r.role.displayName === "Employee 3")!;
      expect(employee3.permissions.map((p) => p.permissionKey).sort()).toEqual(DEFAULT_ROLE_TEMPLATES.employee3.permissionKeys.slice().sort());
      expect(employee3.permissions.every((p) => ["dashboard.view", "balances.view", "customers.view", "agreements.view", "payments.view", "reports.view", "documents.view"].includes(p.permissionKey))).toBe(true);
    });

    it("is idempotent — a second call for the same organization does not duplicate roles", async () => {
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_A);
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_A);
      const roles = await ctx.roles.listRolesForOrganization(ORG_A);
      expect(roles).toHaveLength(4);
    });

    it("at most one owner role per organization is ever created, even across two different organizations independently", async () => {
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_A);
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_B);
      const ownerA = (await ctx.roles.listRolesForOrganization(ORG_A)).filter((r) => r.isOwnerRole);
      const ownerB = (await ctx.roles.listRolesForOrganization(ORG_B)).filter((r) => r.isOwnerRole);
      expect(ownerA).toHaveLength(1);
      expect(ownerB).toHaveLength(1);
    });
  });

  describe("createRole", () => {
    it("creates a role with validated permissions", async () => {
      const role = await ctx.organizationRoleService.createRole({
        organizationId: ORG_A,
        displayName: "Dispatcher",
        description: "Handles load dispatch.",
        permissions: [{ permissionKey: "agreements.view", scope: "organization" }],
      });
      expect(role.displayName).toBe("Dispatcher");
      const permissions = await ctx.roles.listPermissionsForRole(role.id);
      expect(permissions).toHaveLength(1);
    });

    it("rejects an unrecognized permission key", async () => {
      await expect(
        ctx.organizationRoleService.createRole({
          organizationId: ORG_A,
          displayName: "Dispatcher",
          description: null,
          permissions: [{ permissionKey: "not.a.real.permission", scope: "organization" }],
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a scope not yet supported for a given permission", async () => {
      await expect(
        ctx.organizationRoleService.createRole({
          organizationId: ORG_A,
          displayName: "Dispatcher",
          description: null,
          permissions: [{ permissionKey: "agreements.view", scope: "assigned" }],
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a duplicate role name within the SAME organization", async () => {
      await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      await expect(
        ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] }),
      ).rejects.toThrow(ValidationError);
    });

    it("allows the SAME role name across DIFFERENT organizations", async () => {
      await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      const roleB = await ctx.organizationRoleService.createRole({ organizationId: ORG_B, displayName: "Dispatcher", description: null, permissions: [] });
      expect(roleB.displayName).toBe("Dispatcher");
    });
  });

  describe("renaming never changes permissions", () => {
    it("renaming a role preserves its exact permission set", async () => {
      const role = await ctx.organizationRoleService.createRole({
        organizationId: ORG_A,
        displayName: "Dispatcher",
        description: null,
        permissions: [{ permissionKey: "agreements.view", scope: "organization" }, { permissionKey: "customers.view", scope: "organization" }],
      });
      const before = (await ctx.roles.listPermissionsForRole(role.id)).map((p) => p.permissionKey).sort();
      await ctx.organizationRoleService.renameRole(ORG_A, role.id, "Load Coordinator");
      const after = (await ctx.roles.listPermissionsForRole(role.id)).map((p) => p.permissionKey).sort();
      expect(after).toEqual(before);
      const renamed = await ctx.roles.findRoleById(role.id);
      expect(renamed?.displayName).toBe("Load Coordinator");
    });

    it("the Owner role's display name may be renamed (e.g. to President) without losing isOwnerRole/isProtected or any permission", async () => {
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_A);
      const owner = (await ctx.roles.listRolesForOrganization(ORG_A)).find((r) => r.isOwnerRole)!;
      const permissionsBefore = (await ctx.roles.listPermissionsForRole(owner.id)).length;

      await ctx.organizationRoleService.renameRole(ORG_A, owner.id, "President");

      const renamed = await ctx.roles.findRoleById(owner.id);
      expect(renamed?.displayName).toBe("President");
      expect(renamed?.isOwnerRole).toBe(true);
      expect(renamed?.isProtected).toBe(true);
      expect(await ctx.roles.listPermissionsForRole(owner.id)).toHaveLength(permissionsBefore);
    });
  });

  describe("protected Owner role", () => {
    it("cannot be deleted", async () => {
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_A);
      const owner = (await ctx.roles.listRolesForOrganization(ORG_A)).find((r) => r.isOwnerRole)!;
      await expect(ctx.organizationRoleService.deleteRole(ORG_A, owner.id)).rejects.toThrow(ForbiddenError);
      expect(await ctx.roles.findRoleById(owner.id)).not.toBeNull();
    });

    it("cannot have individual permissions removed", async () => {
      await ctx.organizationRoleService.seedDefaultRolesForNewOrganization(ORG_A);
      const owner = (await ctx.roles.listRolesForOrganization(ORG_A)).find((r) => r.isOwnerRole)!;
      await expect(ctx.organizationRoleService.removePermission(ORG_A, owner.id, "subscription.manage")).rejects.toThrow(ForbiddenError);
    });

    it("an ordinary role cannot become the owner role merely by being granted every permission in the catalog", async () => {
      const role = await ctx.organizationRoleService.createRole({
        organizationId: ORG_A,
        displayName: "Everything",
        description: null,
        permissions: PERMISSION_CATALOG.map((p) => ({ permissionKey: p.key, scope: "organization" as const })),
      });
      const stored = await ctx.roles.findRoleById(role.id);
      expect(stored?.isOwnerRole).toBe(false);
      expect(stored?.isProtected).toBe(false);
    });
  });

  describe("role deletion rules (Section 13)", () => {
    it("rejects deleting a role with active members and no reassignment target", async () => {
      const role = await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      ctx.roles.activeMembersByRole.set(role.id, new Set([randomUUID()]));
      await expect(ctx.organizationRoleService.deleteRole(ORG_A, role.id)).rejects.toThrow(ValidationError);
      expect(await ctx.roles.findRoleById(role.id)).not.toBeNull();
    });

    it("rejects deleting a role with a pending invitation and no reassignment target", async () => {
      const role = await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      ctx.roles.pendingInvitationsByRole.set(role.id, new Set([randomUUID()]));
      await expect(ctx.organizationRoleService.deleteRole(ORG_A, role.id)).rejects.toThrow(ValidationError);
    });

    it("deletes cleanly once active members/invitations are explicitly reassigned", async () => {
      const fromRole = await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      const toRole = await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Coordinator", description: null, permissions: [] });
      const memberId = randomUUID();
      ctx.roles.activeMembersByRole.set(fromRole.id, new Set([memberId]));

      await ctx.organizationRoleService.deleteRole(ORG_A, fromRole.id, toRole.id);

      expect(await ctx.roles.findRoleById(fromRole.id)).toBeNull();
      expect(ctx.roles.activeMembersByRole.get(toRole.id)?.has(memberId)).toBe(true);
    });

    it("deletes a role with zero members/invitations with no reassignment needed", async () => {
      const role = await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      await ctx.organizationRoleService.deleteRole(ORG_A, role.id);
      expect(await ctx.roles.findRoleById(role.id)).toBeNull();
    });

    it("rejects reassigning a role's own members to itself", async () => {
      const role = await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      ctx.roles.activeMembersByRole.set(role.id, new Set([randomUUID()]));
      await expect(ctx.organizationRoleService.deleteRole(ORG_A, role.id, role.id)).rejects.toThrow(ValidationError);
    });
  });

  describe("cross-tenant", () => {
    it("a role operation naming the wrong organization is rejected", async () => {
      const role = await ctx.organizationRoleService.createRole({ organizationId: ORG_A, displayName: "Dispatcher", description: null, permissions: [] });
      await expect(ctx.organizationRoleService.renameRole(ORG_B, role.id, "Hijacked")).rejects.toThrow(ValidationError);
      await expect(ctx.organizationRoleService.deleteRole(ORG_B, role.id)).rejects.toThrow(ValidationError);
      const unchanged = await ctx.roles.findRoleById(role.id);
      expect(unchanged?.displayName).toBe("Dispatcher");
    });
  });
});
