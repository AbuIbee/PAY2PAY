import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { StaffRole } from "@/lib/staff/capabilities";
import { DEFAULT_ROLE_CAPABILITIES } from "@/lib/staff/capabilities";
import { LegacyRoleMigrationService, translatedPermissionKeysForLegacyRole } from "./legacyRoleMigration";
import { InMemoryLegacyRoleMigrationRepository } from "./legacyRoleMigrationTestFakes";
import { InMemoryOrganizationRoleRepository } from "./organizationRoleTestFakes";

function createCtx() {
  const legacy = new InMemoryLegacyRoleMigrationRepository();
  const roles = new InMemoryOrganizationRoleRepository();
  const service = new LegacyRoleMigrationService(legacy, roles);
  return { legacy, roles, service };
}

describe("LegacyRoleMigrationService", () => {
  let ctx: ReturnType<typeof createCtx>;
  const ORG_A = randomUUID();
  const ORG_B = randomUUID();

  beforeEach(() => {
    ctx = createCtx();
  });

  it("zero organizations: migrateAllOrganizations is a clean no-op", async () => {
    const result = await ctx.service.migrateAllOrganizations();
    expect(result).toEqual({ organizationsProcessed: 0, membershipsBackfilled: 0, invitationsBackfilled: 0 });
  });

  it("an existing organization with an OWNER member: preserves membership, creates a protected Owner role, backfills roleId", async () => {
    const member = ctx.legacy.seedMembership(ORG_A, "OWNER");
    const result = await ctx.service.migrateOrganization(ORG_A);
    expect(result.membershipsBackfilled).toBe(1);

    const roles = await ctx.roles.listRolesForOrganization(ORG_A);
    expect(roles).toHaveLength(1);
    expect(roles[0]?.displayName).toBe("Owner");
    expect(roles[0]?.isOwnerRole).toBe(true);
    expect(roles[0]?.isProtected).toBe(true);

    expect(ctx.legacy.memberships.find((m) => m.id === member.id)?.roleId).toBe(roles[0]?.id);
    // Membership itself (the row, its organization, its original legacy role) is untouched/preserved.
    expect(ctx.legacy.memberships.find((m) => m.id === member.id)?.role).toBe("OWNER");
  });

  it("every legacy role produces a correctly-named, non-empty-permission equivalent role, preserving effective permissions", async () => {
    const roles: StaffRole[] = ["OWNER", "FINANCE_ADMIN", "AR_MANAGER", "AR_AGENT", "VIEWER"];
    const expectedNames: Record<StaffRole, string> = {
      OWNER: "Owner",
      FINANCE_ADMIN: "Finance Administrator",
      AR_MANAGER: "AR Manager",
      AR_AGENT: "AR Agent",
      VIEWER: "Viewer",
    };
    for (const role of roles) ctx.legacy.seedMembership(ORG_A, role);

    await ctx.service.migrateOrganization(ORG_A);
    const createdRoles = await ctx.roles.listRolesForOrganization(ORG_A);
    expect(createdRoles).toHaveLength(5);

    for (const role of roles) {
      const created = createdRoles.find((r) => r.displayName === expectedNames[role]);
      expect(created, `expected a migrated role for legacy ${role}`).toBeDefined();
      const permissions = await ctx.roles.listPermissionsForRole(created!.id);
      const expectedKeys = translatedPermissionKeysForLegacyRole(role);
      expect(permissions.map((p) => p.permissionKey).sort()).toEqual([...expectedKeys].sort());
      if (role === "VIEWER") {
        // Legacy VIEWER had zero CAPABILITIES (capabilities.ts: VIEWER: []), but — pre-cutover — any
        // active member, VIEWER included, could still read ordinary (non-sensitive) organization
        // resources (OrganizationAuthorizationService.canReadOrganizationResource). The migrated role
        // preserves exactly that ambient read access, never a mutation capability.
        expect(permissions.length).toBeGreaterThan(0);
        expect(permissions.every((p) => p.permissionKey.endsWith(".view"))).toBe(true);
      } else {
        expect(permissions.length).toBeGreaterThan(0);
      }
    }
  });

  it("preserves pending invitations and backfills their roleId alongside memberships", async () => {
    ctx.legacy.seedMembership(ORG_A, "OWNER");
    const invitation = ctx.legacy.seedInvitation(ORG_A, "FINANCE_ADMIN");

    const result = await ctx.service.migrateOrganization(ORG_A);
    expect(result.invitationsBackfilled).toBe(1);

    const financeAdminRole = (await ctx.roles.listRolesForOrganization(ORG_A)).find((r) => r.displayName === "Finance Administrator");
    expect(ctx.legacy.invitations.find((i) => i.id === invitation.id)?.roleId).toBe(financeAdminRole?.id);
    expect(ctx.legacy.invitations.find((i) => i.id === invitation.id)?.role).toBe("FINANCE_ADMIN");
  });

  it("multiple organizations: each gets its own independent set of equivalent roles, never cross-contaminated", async () => {
    ctx.legacy.seedMembership(ORG_A, "OWNER");
    ctx.legacy.seedMembership(ORG_A, "AR_MANAGER");
    ctx.legacy.seedMembership(ORG_B, "OWNER");
    ctx.legacy.seedMembership(ORG_B, "VIEWER");

    const result = await ctx.service.migrateAllOrganizations();
    expect(result.organizationsProcessed).toBe(2);
    expect(result.membershipsBackfilled).toBe(4);

    const rolesA = await ctx.roles.listRolesForOrganization(ORG_A);
    const rolesB = await ctx.roles.listRolesForOrganization(ORG_B);
    expect(rolesA.map((r) => r.displayName).sort()).toEqual(["AR Manager", "Owner"]);
    expect(rolesB.map((r) => r.displayName).sort()).toEqual(["Owner", "Viewer"]);
    // Every role's organizationId matches the organization it was created for — no orphan/cross-tenant role.
    expect(rolesA.every((r) => r.organizationId === ORG_A)).toBe(true);
    expect(rolesB.every((r) => r.organizationId === ORG_B)).toBe(true);
  });

  it("duplicate role names across different organizations do not conflict (each organization's \"Owner\" is its own row)", async () => {
    ctx.legacy.seedMembership(ORG_A, "OWNER");
    ctx.legacy.seedMembership(ORG_B, "OWNER");
    await ctx.service.migrateAllOrganizations();

    const ownerA = (await ctx.roles.listRolesForOrganization(ORG_A)).find((r) => r.displayName === "Owner");
    const ownerB = (await ctx.roles.listRolesForOrganization(ORG_B)).find((r) => r.displayName === "Owner");
    expect(ownerA?.id).not.toBe(ownerB?.id);
    expect(ownerA?.organizationId).toBe(ORG_A);
    expect(ownerB?.organizationId).toBe(ORG_B);
  });

  it("is idempotent: running the migration twice does not duplicate roles or re-backfill already-set memberships", async () => {
    const member = ctx.legacy.seedMembership(ORG_A, "FINANCE_ADMIN");
    await ctx.service.migrateOrganization(ORG_A);
    const roleIdAfterFirst = ctx.legacy.memberships.find((m) => m.id === member.id)?.roleId;

    await ctx.service.migrateOrganization(ORG_A);
    const roles = await ctx.roles.listRolesForOrganization(ORG_A);
    expect(roles).toHaveLength(1);
    expect(ctx.legacy.memberships.find((m) => m.id === member.id)?.roleId).toBe(roleIdAfterFirst);
  });

  it("no orphan role IDs: every backfilled roleId corresponds to a role that genuinely belongs to that same membership's organization", async () => {
    ctx.legacy.seedMembership(ORG_A, "AR_AGENT");
    ctx.legacy.seedMembership(ORG_B, "AR_AGENT");
    await ctx.service.migrateAllOrganizations();

    for (const membership of ctx.legacy.memberships) {
      expect(membership.roleId).not.toBeNull();
      const role = await ctx.roles.findRoleById(membership.roleId!);
      expect(role).not.toBeNull();
      expect(role?.organizationId).toBe(membership.organizationId);
    }
  });

  it("the translation table maps every one of FINANCE_ADMIN's legacy capabilities onto at least one new permission key, and grants nothing FINANCE_ADMIN never had", () => {
    const keys = new Set(translatedPermissionKeysForLegacyRole("FINANCE_ADMIN"));
    expect(keys.has("agreements.create")).toBe(true);
    expect(keys.has("members.invite")).toBe(true);
    // FINANCE_ADMIN held manage_staff under the old model — the translated set must include the
    // full member/role-administration permission group that capability expands to.
    expect(keys.has("members.remove")).toBe(true);
    expect(keys.has("roles.assign")).toBe(true);
    // FINANCE_ADMIN never held manage_subscription/manage_integrations/manage_organization_settings
    // under the old model (OWNER-only, per capabilities.ts) — the translation must not grant them.
    expect(DEFAULT_ROLE_CAPABILITIES.FINANCE_ADMIN).not.toContain("manage_subscription");
    expect(keys.has("subscription.manage")).toBe(false);
    expect(keys.has("integrations.connect")).toBe(false);
  });
});
