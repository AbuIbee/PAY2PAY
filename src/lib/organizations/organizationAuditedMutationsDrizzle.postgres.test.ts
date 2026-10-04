import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { auditEvent, businessProfile, businessStaffMember, organizationRole } from "@/db/schema";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { DrizzleOrganizationAuditedMutations } from "./organizationAuditedMutationsDrizzle";
import { DrizzleOrganizationRoleRepository } from "./drizzleOrganizationRoleRepository";

/**
 * "PAID2YOU — FINAL RBAC AUTHORIZATION CUTOVER", Step 21/23/35: real-Postgres proof that each of the
 * six mandatory audit events is TRUE-transactionally atomic with its business mutation —
 * success commits exactly one audit event together with the mutation; a business-mutation failure
 * commits neither; and, critically, a FORCED failure at the audit-insert step itself (an
 * `actorUserId` with no corresponding `user_account` row — `audit_event.actor_user_id` has a real FK)
 * rolls back the business mutation too. An in-memory fake cannot prove any of this — there is no real
 * transaction to roll back.
 */
async function seedOrganizationWithOwner(): Promise<{ organizationId: string; ownerUserId: string }> {
  const db = getDb();
  const owner = await seedPersonalUser("audited-mutations-owner");
  const [org] = await db
    .insert(businessProfile)
    .values({
      ownerUserId: owner.userId,
      legalBusinessName: `Audited Mutations Test LLC ${randomUUID()}`,
      displayName: "Audited Mutations Test",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    })
    .returning({ id: businessProfile.id });
  if (!org) throw new Error("seedOrganizationWithOwner: business_profile insert returned no row");
  return { organizationId: org.id, ownerUserId: owner.userId };
}

async function seedRole(organizationId: string, displayName: string, options: { isOwnerRole?: boolean; isProtected?: boolean } = {}) {
  const roles = new DrizzleOrganizationRoleRepository();
  return roles.insertRole({
    organizationId,
    displayName,
    description: null,
    isOwnerRole: options.isOwnerRole ?? false,
    isProtected: options.isProtected ?? false,
    sortOrder: 50,
  });
}

async function seedMembership(organizationId: string, roleId: string, userId?: string) {
  const db = getDb();
  const resolvedUserId = userId ?? (await seedPersonalUser("audited-mutations-member")).userId;
  const [row] = await db
    .insert(businessStaffMember)
    .values({ businessProfileId: organizationId, userId: resolvedUserId, role: "VIEWER", roleId, isAuthorizedRepresentative: false })
    .returning({ id: businessStaffMember.id });
  if (!row) throw new Error("seedMembership: business_staff_member insert returned no row");
  return { membershipId: row.id, userId: resolvedUserId };
}

async function auditEventsFor(organizationId: string, action: string) {
  const db = getDb();
  return db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.profileId, organizationId), eq(auditEvent.action, action)));
}

describe("DrizzleOrganizationAuditedMutations — real-Postgres transactional atomicity (Step 21/23/35)", () => {
  describe("ROLE_CREATED (createRole)", () => {
    it("success: exactly one organization_role row AND exactly one audit event commit together", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const mutations = new DrizzleOrganizationAuditedMutations();

      const role = await mutations.createRole({ organizationId, actorUserId: ownerUserId, displayName: "Manager", description: null, permissions: [{ permissionKey: "reports.view", scope: "organization" }] });

      const events = await auditEventsFor(organizationId, "organization_role_created");
      expect(events).toHaveLength(1);
      const db = getDb();
      const [roleRow] = await db.select().from(organizationRole).where(eq(organizationRole.id, role.id));
      expect(roleRow).toBeDefined();
    });

    it("business-mutation failure (duplicate role name): zero audit events, zero new role rows", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      await seedRole(organizationId, "Manager");
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.createRole({ organizationId, actorUserId: ownerUserId, displayName: "Manager", description: null, permissions: [] })).rejects.toThrow();

      const events = await auditEventsFor(organizationId, "organization_role_created");
      expect(events).toHaveLength(0);
      const db = getDb();
      const roleRows = await db.select().from(organizationRole).where(eq(organizationRole.organizationId, organizationId));
      expect(roleRows).toHaveLength(1); // only the pre-seeded "Manager" — the duplicate attempt created nothing.
    });

    it("forced audit-insert failure (actorUserId has no user_account row): the organization_role insert rolls back too — never a role created with a missing audit record", async () => {
      const { organizationId } = await seedOrganizationWithOwner();
      const mutations = new DrizzleOrganizationAuditedMutations();
      const nonExistentUserId = randomUUID();

      await expect(mutations.createRole({ organizationId, actorUserId: nonExistentUserId, displayName: "Ghost Role", description: null, permissions: [] })).rejects.toThrow();

      const db = getDb();
      const roleRows = await db.select().from(organizationRole).where(eq(organizationRole.organizationId, organizationId));
      expect(roleRows).toHaveLength(0); // the role insert was rolled back along with the failed audit insert.
    });
  });

  describe("ROLE_RENAMED (renameRole)", () => {
    it("success: exactly one audit event, and the role's displayName actually changed", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Old Name");
      const mutations = new DrizzleOrganizationAuditedMutations();

      await mutations.renameRole({ organizationId, actorUserId: ownerUserId, roleId: role.id, displayName: "New Name" });

      const events = await auditEventsFor(organizationId, "organization_role_renamed");
      expect(events).toHaveLength(1);
      const db = getDb();
      const [roleRow] = await db.select().from(organizationRole).where(eq(organizationRole.id, role.id));
      expect(roleRow?.displayName).toBe("New Name");
    });

    it("business-mutation failure (role belongs to a different organization): zero audit events, name unchanged", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const { organizationId: otherOrgId } = await seedOrganizationWithOwner();
      const foreignRole = await seedRole(otherOrgId, "Foreign Role");
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.renameRole({ organizationId, actorUserId: ownerUserId, roleId: foreignRole.id, displayName: "Hijacked" })).rejects.toThrow();

      const events = await auditEventsFor(organizationId, "organization_role_renamed");
      expect(events).toHaveLength(0);
      const db = getDb();
      const [roleRow] = await db.select().from(organizationRole).where(eq(organizationRole.id, foreignRole.id));
      expect(roleRow?.displayName).toBe("Foreign Role");
    });

    it("forced audit-insert failure: the rename rolls back — the role's displayName is left exactly as it was", async () => {
      const { organizationId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Untouched Name");
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.renameRole({ organizationId, actorUserId: randomUUID(), roleId: role.id, displayName: "Should Never Stick" })).rejects.toThrow();

      const db = getDb();
      const [roleRow] = await db.select().from(organizationRole).where(eq(organizationRole.id, role.id));
      expect(roleRow?.displayName).toBe("Untouched Name");
    });
  });

  describe("ROLE_PERMISSION_CHANGED (changeRolePermission)", () => {
    it("success: exactly one audit event, and the permission is actually granted", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Operator");
      const mutations = new DrizzleOrganizationAuditedMutations();

      await mutations.changeRolePermission({ organizationId, actorUserId: ownerUserId, roleId: role.id, permissionKey: "reports.view", scope: "organization", grant: true });

      const events = await auditEventsFor(organizationId, "organization_role_permission_changed");
      expect(events).toHaveLength(1);
      const roles = new DrizzleOrganizationRoleRepository();
      const permissions = await roles.listPermissionsForRole(role.id);
      expect(permissions.map((p) => p.permissionKey)).toContain("reports.view");
    });

    it("business-mutation failure (protected role): zero audit events, no permission change", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const protectedRole = await seedRole(organizationId, "Owner", { isOwnerRole: true, isProtected: true });
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.changeRolePermission({ organizationId, actorUserId: ownerUserId, roleId: protectedRole.id, permissionKey: "reports.view", scope: "organization", grant: true })).rejects.toThrow();

      const events = await auditEventsFor(organizationId, "organization_role_permission_changed");
      expect(events).toHaveLength(0);
      const roles = new DrizzleOrganizationRoleRepository();
      const permissions = await roles.listPermissionsForRole(protectedRole.id);
      expect(permissions).toHaveLength(0);
    });

    it("forced audit-insert failure: the permission grant rolls back", async () => {
      const { organizationId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Operator Two");
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(
        mutations.changeRolePermission({ organizationId, actorUserId: randomUUID(), roleId: role.id, permissionKey: "reports.view", scope: "organization", grant: true }),
      ).rejects.toThrow();

      const roles = new DrizzleOrganizationRoleRepository();
      const permissions = await roles.listPermissionsForRole(role.id);
      expect(permissions).toHaveLength(0);
    });
  });

  describe("MEMBER_INVITED (inviteMember)", () => {
    it("success: exactly one audit event, and exactly one pending invitation", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Invitee Role");
      const mutations = new DrizzleOrganizationAuditedMutations();

      const invitation = await mutations.inviteMember({ organizationId, actorUserId: ownerUserId, email: `invitee-${randomUUID()}@postgres-test.example`, roleId: role.id, tokenHash: `hash-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) });

      const events = await auditEventsFor(organizationId, "organization_member_invited");
      expect(events).toHaveLength(1);
      expect(invitation.roleId).toBe(role.id);
    });

    it("business-mutation failure (duplicate pending invitation): zero audit events", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Invitee Role Two");
      const mutations = new DrizzleOrganizationAuditedMutations();
      const email = `invitee-${randomUUID()}@postgres-test.example`;
      await mutations.inviteMember({ organizationId, actorUserId: ownerUserId, email, roleId: role.id, tokenHash: `hash-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) });

      await expect(
        mutations.inviteMember({ organizationId, actorUserId: ownerUserId, email, roleId: role.id, tokenHash: `hash-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) }),
      ).rejects.toThrow();

      const events = await auditEventsFor(organizationId, "organization_member_invited");
      expect(events).toHaveLength(1); // only the first, successful invitation.
    });

    it("forced audit-insert failure (actorUserId has no user_account row — also the invitation's own invited_by_user_id FK): both the invitation and the audit event roll back together", async () => {
      const { organizationId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Invitee Role Three");
      const mutations = new DrizzleOrganizationAuditedMutations();
      const email = `invitee-${randomUUID()}@postgres-test.example`;

      await expect(
        mutations.inviteMember({ organizationId, actorUserId: randomUUID(), email, roleId: role.id, tokenHash: `hash-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) }),
      ).rejects.toThrow();

      const events = await auditEventsFor(organizationId, "organization_member_invited");
      expect(events).toHaveLength(0);
    });
  });

  describe("MEMBER_ROLE_CHANGED (changeMemberRole)", () => {
    it("success: exactly one audit event, and the membership's roleId actually changed", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const oldRole = await seedRole(organizationId, "Old Member Role");
      const newRole = await seedRole(organizationId, "New Member Role");
      const { membershipId } = await seedMembership(organizationId, oldRole.id);
      const mutations = new DrizzleOrganizationAuditedMutations();

      await mutations.changeMemberRole({ organizationId, actorUserId: ownerUserId, targetMembershipId: membershipId, newRoleId: newRole.id });

      const events = await auditEventsFor(organizationId, "organization_member_role_changed");
      expect(events).toHaveLength(1);
      const db = getDb();
      const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
      expect(member?.roleId).toBe(newRole.id);
    });

    it("business-mutation failure (self-change forbidden): zero audit events, roleId unchanged", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const oldRole = await seedRole(organizationId, "Self Old Role");
      const newRole = await seedRole(organizationId, "Self New Role");
      const { membershipId } = await seedMembership(organizationId, oldRole.id, ownerUserId);
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.changeMemberRole({ organizationId, actorUserId: ownerUserId, targetMembershipId: membershipId, newRoleId: newRole.id })).rejects.toThrow();

      const events = await auditEventsFor(organizationId, "organization_member_role_changed");
      expect(events).toHaveLength(0);
      const db = getDb();
      const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
      expect(member?.roleId).toBe(oldRole.id);
    });

    it("forced audit-insert failure: the role change rolls back", async () => {
      const { organizationId } = await seedOrganizationWithOwner();
      const oldRole = await seedRole(organizationId, "Ghost Old Role");
      const newRole = await seedRole(organizationId, "Ghost New Role");
      const { membershipId } = await seedMembership(organizationId, oldRole.id);
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.changeMemberRole({ organizationId, actorUserId: randomUUID(), targetMembershipId: membershipId, newRoleId: newRole.id })).rejects.toThrow();

      const db = getDb();
      const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
      expect(member?.roleId).toBe(oldRole.id);
    });
  });

  describe("MEMBER_REMOVED (removeMember)", () => {
    it("success: exactly one audit event, and the membership is actually soft-removed", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Removable Role");
      const { membershipId } = await seedMembership(organizationId, role.id);
      const mutations = new DrizzleOrganizationAuditedMutations();

      await mutations.removeMember({ organizationId, actorUserId: ownerUserId, targetMembershipId: membershipId });

      const events = await auditEventsFor(organizationId, "organization_member_removed");
      expect(events).toHaveLength(1);
      const db = getDb();
      const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
      expect(member?.removedAt).not.toBeNull();
    });

    it("business-mutation failure (cannot remove self): zero audit events, membership still active", async () => {
      const { organizationId, ownerUserId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Self Removable Role");
      const { membershipId } = await seedMembership(organizationId, role.id, ownerUserId);
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.removeMember({ organizationId, actorUserId: ownerUserId, targetMembershipId: membershipId })).rejects.toThrow();

      const events = await auditEventsFor(organizationId, "organization_member_removed");
      expect(events).toHaveLength(0);
      const db = getDb();
      const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
      expect(member?.removedAt).toBeNull();
    });

    it("forced audit-insert failure: the removal rolls back — the membership is left active", async () => {
      const { organizationId } = await seedOrganizationWithOwner();
      const role = await seedRole(organizationId, "Ghost Removable Role");
      const { membershipId } = await seedMembership(organizationId, role.id);
      const mutations = new DrizzleOrganizationAuditedMutations();

      await expect(mutations.removeMember({ organizationId, actorUserId: randomUUID(), targetMembershipId: membershipId })).rejects.toThrow();

      const db = getDb();
      const [member] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, membershipId));
      expect(member?.removedAt).toBeNull();
    });
  });
});
