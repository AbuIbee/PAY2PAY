import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { businessProfile, businessStaffInvitation, businessStaffMember, organizationRole } from "@/db/schema";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { DrizzleOrganizationRoleRepository } from "./drizzleOrganizationRoleRepository";
import { getLegacyRoleMigrationService } from "./getLegacyRoleMigrationService";

/**
 * "PAID2YOU — FINAL RBAC AUTHORIZATION CUTOVER", Step 32: the migration/backfill proof scenarios,
 * run against REAL Postgres — `legacyRoleMigration.test.ts` already proves this logic exhaustively
 * (including the "membership/invitation requiring backfill" scenarios) against in-memory fakes, which
 * model the repository contract directly and can therefore construct a null-role_id row to backfill.
 *
 * This file proves the SAME `LegacyRoleMigrationService`, wired to its real
 * `DrizzleLegacyRoleMigrationRepository`/`DrizzleOrganizationRoleRepository` (via the production
 * `getLegacyRoleMigrationService()` factory — never a hand-rolled substitute), against a genuine
 * migrated database — real UUID FKs, real unique indexes.
 *
 * IMPORTANT — why this file does NOT also construct a null-role_id row directly: once
 * `business_staff_member_active_role_id_required`/`business_staff_invitation_pending_role_id_required`
 * (supabase/migrations/20261003040000_final_rbac_role_id_constraints.sql) exist in the schema, the
 * database itself makes that precondition impossible to construct via an ordinary INSERT — which is
 * exactly the constraint doing its job (Step 6). Two tests below (G/H) prove that directly: the
 * database rejects the attempt outright, rather than silently accepting it. The scenarios where the
 * migration's OWN backfill loop actually RUNS against a null roleId are — by construction, now that
 * the constraint exists — only reachable for data that predates this migration being applied; that
 * exact pre-deployment path is scripts/backfill-legacy-organization-roles.ts, and its correctness is
 * proven by legacyRoleMigration.test.ts's in-memory suite, which exercises the repository contract
 * without this real constraint in the way.
 */
async function seedOrganization(): Promise<string> {
  const db = getDb();
  const owner = await seedPersonalUser("legacy-migration-org-owner");
  const [org] = await db
    .insert(businessProfile)
    .values({
      ownerUserId: owner.userId,
      legalBusinessName: `Legacy Migration Test LLC ${randomUUID()}`,
      displayName: "Legacy Migration Test",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    })
    .returning({ id: businessProfile.id });
  if (!org) throw new Error("seedOrganization: business_profile insert returned no row");
  return org.id;
}

/** Mirrors the real mutation-time contract (StaffService): role_id is always resolved BEFORE insert. */
async function seedLegacyMembership(organizationId: string, role: "OWNER" | "FINANCE_ADMIN" | "AR_MANAGER" | "AR_AGENT" | "VIEWER", roleIdOverride?: string): Promise<string> {
  const db = getDb();
  const user = await seedPersonalUser("legacy-migration-member");
  const roleId = roleIdOverride ?? (await getLegacyRoleMigrationService().resolveOrCreateEquivalentRole(organizationId, role));
  const [row] = await db
    .insert(businessStaffMember)
    .values({ businessProfileId: organizationId, userId: user.userId, role, roleId, isAuthorizedRepresentative: role === "OWNER" })
    .returning({ id: businessStaffMember.id });
  if (!row) throw new Error("seedLegacyMembership: business_staff_member insert returned no row");
  return row.id;
}

describe("LegacyRoleMigrationService — real-Postgres migration/backfill proof (Step 32)", () => {
  it("A: an organization nobody has ever touched — migrateOrganization is a clean no-op against real Postgres", async () => {
    const organizationId = await seedOrganization();
    const result = await getLegacyRoleMigrationService().migrateOrganization(organizationId);
    expect(result).toEqual({ organizationsProcessed: 1, membershipsBackfilled: 0, invitationsBackfilled: 0 });
  });

  it("B: resolveOrCreateEquivalentRole for OWNER creates a protected, owner-flagged organization_role with the full permission catalog, and is idempotent", async () => {
    const organizationId = await seedOrganization();
    const roles = new DrizzleOrganizationRoleRepository();

    const roleId1 = await getLegacyRoleMigrationService().resolveOrCreateEquivalentRole(organizationId, "OWNER");
    const role = await roles.findRoleById(roleId1);
    expect(role?.displayName).toBe("Owner");
    expect(role?.isOwnerRole).toBe(true);
    expect(role?.isProtected).toBe(true);
    const permissions = await roles.listPermissionsForRole(roleId1);
    expect(permissions.length).toBeGreaterThan(40); // full catalog, not a partial grant

    // Idempotent: a second call for the SAME organization+legacy-role returns the SAME row, never a
    // duplicate "Owner" role.
    const roleId2 = await getLegacyRoleMigrationService().resolveOrCreateEquivalentRole(organizationId, "OWNER");
    expect(roleId2).toBe(roleId1);
    const db = getDb();
    const ownerRows = await db.select().from(organizationRole).where(eq(organizationRole.organizationId, organizationId));
    expect(ownerRows.filter((r) => r.displayName === "Owner")).toHaveLength(1);
  });

  it("C: an organization with all 5 legacy roles — each gets its own correctly-named equivalent role, with AR_AGENT excluded from agreements.create (Phase 8 parity preserved)", async () => {
    const organizationId = await seedOrganization();
    const memberships = {
      OWNER: await seedLegacyMembership(organizationId, "OWNER"),
      FINANCE_ADMIN: await seedLegacyMembership(organizationId, "FINANCE_ADMIN"),
      AR_MANAGER: await seedLegacyMembership(organizationId, "AR_MANAGER"),
      AR_AGENT: await seedLegacyMembership(organizationId, "AR_AGENT"),
      VIEWER: await seedLegacyMembership(organizationId, "VIEWER"),
    } as const;

    const db = getDb();
    const roles = new DrizzleOrganizationRoleRepository();
    for (const [legacyRole, membershipId] of Object.entries(memberships)) {
      const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
      expect(member?.roleId, `${legacyRole} should have a non-null roleId`).not.toBeNull();
      const permissions = await roles.listPermissionsForRole(member!.roleId!);
      const keys = new Set(permissions.map((p) => p.permissionKey));
      if (legacyRole === "AR_MANAGER") expect(keys.has("agreements.create")).toBe(true);
      if (legacyRole === "AR_AGENT") expect(keys.has("agreements.create")).toBe(false);
    }
  });

  it("D: two organizations each with a legacy OWNER — duplicate role display names never collide; each organization gets its own independent Owner role row", async () => {
    const orgA = await seedOrganization();
    const orgB = await seedOrganization();
    const memberA = await seedLegacyMembership(orgA, "OWNER");
    const memberB = await seedLegacyMembership(orgB, "OWNER");

    const db = getDb();
    const [rowA] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, memberA));
    const [rowB] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, memberB));
    expect(rowA?.roleId).not.toBe(rowB?.roleId);

    const [roleA] = await db.select().from(organizationRole).where(eq(organizationRole.id, rowA!.roleId!));
    const [roleB] = await db.select().from(organizationRole).where(eq(organizationRole.id, rowB!.roleId!));
    expect(roleA?.organizationId).toBe(orgA);
    expect(roleB?.organizationId).toBe(orgB);
  });

  it("F: migrateOrganization never touches a membership whose role_id is ALREADY populated, even with an unrelated hand-crafted role", async () => {
    const organizationId = await seedOrganization();
    const roles = new DrizzleOrganizationRoleRepository();
    const preExistingRole = await roles.insertRole({
      organizationId,
      displayName: "Hand-Crafted Role",
      description: null,
      isOwnerRole: false,
      isProtected: false,
      sortOrder: 99,
    });
    const membershipId = await seedLegacyMembership(organizationId, "FINANCE_ADMIN", preExistingRole.id);

    const result = await getLegacyRoleMigrationService().migrateOrganization(organizationId);
    expect(result.membershipsBackfilled).toBe(0);

    const db = getDb();
    const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
    expect(member?.roleId).toBe(preExistingRole.id);
  });

  it("G: the database itself rejects an attempt to insert an active membership with a null role_id — the constraint, not a silent default, is what prevents this precondition from ever existing again", async () => {
    const organizationId = await seedOrganization();
    const user = await seedPersonalUser("legacy-migration-rejected-member");
    const db = getDb();
    await expect(
      db.insert(businessStaffMember).values({ businessProfileId: organizationId, userId: user.userId, role: "VIEWER", isAuthorizedRepresentative: false }),
    ).rejects.toMatchObject({ cause: { constraint_name: "business_staff_member_active_role_id_required" } });
  });

  it("H: the database itself rejects an attempt to insert a pending invitation with a null role_id", async () => {
    const organizationId = await seedOrganization();
    const inviter = await seedPersonalUser("legacy-migration-inviter");
    const db = getDb();
    await expect(
      db.insert(businessStaffInvitation).values({
        businessProfileId: organizationId,
        email: `pending-${randomUUID()}@postgres-test.example`,
        role: "FINANCE_ADMIN",
        invitedByUserId: inviter.userId,
        tokenHash: `token-hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: { constraint_name: "business_staff_invitation_pending_role_id_required" } });
  });

  it("I: a membership whose role_id points at a DIFFERENT organization's role is never 'fixed' or reinterpreted by the migration — it is simply left alone (already non-null)", async () => {
    const orgA = await seedOrganization();
    const orgB = await seedOrganization();
    const roles = new DrizzleOrganizationRoleRepository();
    const orgBRole = await roles.insertRole({ organizationId: orgB, displayName: "Org B Role", description: null, isOwnerRole: false, isProtected: false, sortOrder: 0 });
    // A membership in Org A, pointed at a role that belongs to Org B — the migration must never
    // "repair" this into something valid; rejecting it as a live authorization grant is
    // OrganizationPermissionService's own, separately-tested cross-tenant defense
    // (organizationPermissionService.test.ts). This test proves the migration's OWN contract: it does
    // not inspect or validate an already-non-null role_id, cross-tenant or not — it only ever fills in
    // a null one, and this one is never null.
    const membershipId = await seedLegacyMembership(orgA, "FINANCE_ADMIN", orgBRole.id);

    const result = await getLegacyRoleMigrationService().migrateOrganization(orgA);
    expect(result.membershipsBackfilled).toBe(0);

    const db = getDb();
    const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
    expect(member?.roleId).toBe(orgBRole.id);
  });

  it("J: running migrateOrganization twice against the same fully-resolved organization is idempotent — no duplicate roles, no changed roleId", async () => {
    const organizationId = await seedOrganization();
    const membershipId = await seedLegacyMembership(organizationId, "VIEWER");

    const db = getDb();
    const [before] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
    const roleIdBefore = before?.roleId;

    const first = await getLegacyRoleMigrationService().migrateOrganization(organizationId);
    const second = await getLegacyRoleMigrationService().migrateOrganization(organizationId);
    expect(first.membershipsBackfilled).toBe(0);
    expect(second.membershipsBackfilled).toBe(0);

    const [after] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
    expect(after?.roleId).toBe(roleIdBefore);

    const roleRows = await db.select().from(organizationRole).where(eq(organizationRole.organizationId, organizationId));
    expect(roleRows.filter((r) => r.displayName === "Viewer")).toHaveLength(1);
  });
});
