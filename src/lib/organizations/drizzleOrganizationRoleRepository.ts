import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessStaffInvitation, businessStaffMember, organizationRole, organizationRolePermission } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { OrganizationRoleRecord, OrganizationRolePermissionRecord, OrganizationRoleRepository } from "./organizationRoleRepository";
import type { PermissionScope } from "./permissionCatalog";

type RoleRow = typeof organizationRole.$inferSelect;
type PermissionRow = typeof organizationRolePermission.$inferSelect;

function toRoleRecord(row: RoleRow): OrganizationRoleRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    displayName: row.displayName,
    description: row.description,
    isOwnerRole: row.isOwnerRole,
    isProtected: row.isProtected,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPermissionRecord(row: PermissionRow): OrganizationRolePermissionRecord {
  return { id: row.id, roleId: row.roleId, permissionKey: row.permissionKey, scope: row.scope as PermissionScope, createdAt: row.createdAt };
}

export class DrizzleOrganizationRoleRepository implements OrganizationRoleRepository {
  async insertRole(input: {
    organizationId: string;
    displayName: string;
    description: string | null;
    isOwnerRole: boolean;
    isProtected: boolean;
    sortOrder: number;
  }): Promise<OrganizationRoleRecord> {
    const db = getDb();
    const [row] = await db.insert(organizationRole).values(input).returning();
    if (!row) throw new ConfigurationError("organization_role insert returned no row");
    return toRoleRecord(row);
  }

  async findRoleById(id: string): Promise<OrganizationRoleRecord | null> {
    const db = getDb();
    const rows = await db.select().from(organizationRole).where(eq(organizationRole.id, id)).limit(1);
    const row = rows[0];
    return row ? toRoleRecord(row) : null;
  }

  async findRoleForOrganization(organizationId: string, roleId: string): Promise<OrganizationRoleRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(organizationRole)
      .where(and(eq(organizationRole.id, roleId), eq(organizationRole.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    return row ? toRoleRecord(row) : null;
  }

  async findRoleByOrganizationAndName(organizationId: string, displayName: string): Promise<OrganizationRoleRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(organizationRole)
      .where(and(eq(organizationRole.organizationId, organizationId), eq(organizationRole.displayName, displayName)))
      .limit(1);
    const row = rows[0];
    return row ? toRoleRecord(row) : null;
  }

  async findOwnerRoleForOrganization(organizationId: string): Promise<OrganizationRoleRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(organizationRole)
      .where(and(eq(organizationRole.organizationId, organizationId), eq(organizationRole.isOwnerRole, true)))
      .limit(1);
    const row = rows[0];
    return row ? toRoleRecord(row) : null;
  }

  async listRolesForOrganization(organizationId: string): Promise<OrganizationRoleRecord[]> {
    const db = getDb();
    const rows = await db.select().from(organizationRole).where(eq(organizationRole.organizationId, organizationId));
    return rows.map(toRoleRecord);
  }

  async renameRole(id: string, displayName: string): Promise<void> {
    const db = getDb();
    await db.update(organizationRole).set({ displayName, updatedAt: new Date() }).where(eq(organizationRole.id, id));
  }

  async updateDescription(id: string, description: string | null): Promise<void> {
    const db = getDb();
    await db.update(organizationRole).set({ description, updatedAt: new Date() }).where(eq(organizationRole.id, id));
  }

  async deleteRole(id: string): Promise<void> {
    const db = getDb();
    await db.delete(organizationRole).where(eq(organizationRole.id, id));
  }

  async insertPermission(input: { roleId: string; permissionKey: string; scope: PermissionScope }): Promise<OrganizationRolePermissionRecord> {
    const db = getDb();
    const [row] = await db.insert(organizationRolePermission).values(input).returning();
    if (!row) throw new ConfigurationError("organization_role_permission insert returned no row");
    return toPermissionRecord(row);
  }

  async removePermission(roleId: string, permissionKey: string): Promise<void> {
    const db = getDb();
    await db.delete(organizationRolePermission).where(and(eq(organizationRolePermission.roleId, roleId), eq(organizationRolePermission.permissionKey, permissionKey)));
  }

  async listPermissionsForRole(roleId: string): Promise<OrganizationRolePermissionRecord[]> {
    const db = getDb();
    const rows = await db.select().from(organizationRolePermission).where(eq(organizationRolePermission.roleId, roleId));
    return rows.map(toPermissionRecord);
  }

  async countActiveMembersForRole(roleId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ id: businessStaffMember.id })
      .from(businessStaffMember)
      .where(and(eq(businessStaffMember.roleId, roleId), isNull(businessStaffMember.removedAt)));
    return rows.length;
  }

  async countPendingInvitationsForRole(roleId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ id: businessStaffInvitation.id })
      .from(businessStaffInvitation)
      .where(and(eq(businessStaffInvitation.roleId, roleId), eq(businessStaffInvitation.status, "pending")));
    return rows.length;
  }

  async reassignActiveMembers(fromRoleId: string, toRoleId: string): Promise<void> {
    const db = getDb();
    await db
      .update(businessStaffMember)
      .set({ roleId: toRoleId, updatedAt: new Date() })
      .where(and(eq(businessStaffMember.roleId, fromRoleId), isNull(businessStaffMember.removedAt)));
  }

  async reassignPendingInvitations(fromRoleId: string, toRoleId: string): Promise<void> {
    const db = getDb();
    await db
      .update(businessStaffInvitation)
      .set({ roleId: toRoleId })
      .where(and(eq(businessStaffInvitation.roleId, fromRoleId), eq(businessStaffInvitation.status, "pending")));
  }
}
