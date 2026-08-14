import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminRoleAssignment } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AdminRoleAssignmentRecord, AdminRoleAssignmentRepository } from "./adminRoleService";
import type { InternalAdminRole } from "./adminCapabilities";

type Row = typeof adminRoleAssignment.$inferSelect;

function toRecord(row: Row): AdminRoleAssignmentRecord {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role as InternalAdminRole,
    assignedByUserId: row.assignedByUserId,
    assignedAt: row.assignedAt,
    revokedByUserId: row.revokedByUserId,
    revokedAt: row.revokedAt,
  };
}

export class DrizzleAdminRoleAssignmentRepository implements AdminRoleAssignmentRepository {
  async insert(input: { userId: string; role: InternalAdminRole; assignedByUserId: string }): Promise<AdminRoleAssignmentRecord> {
    const db = getDb();
    const [row] = await db.insert(adminRoleAssignment).values(input).returning();
    if (!row) throw new ConfigurationError("admin_role_assignment insert returned no row");
    return toRecord(row);
  }

  async findActiveForUser(userId: string): Promise<AdminRoleAssignmentRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(adminRoleAssignment)
      .where(and(eq(adminRoleAssignment.userId, userId), isNull(adminRoleAssignment.revokedAt)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<AdminRoleAssignmentRecord | null> {
    const db = getDb();
    const rows = await db.select().from(adminRoleAssignment).where(eq(adminRoleAssignment.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markRevoked(id: string, revokedByUserId: string, revokedAt: Date): Promise<AdminRoleAssignmentRecord> {
    const db = getDb();
    const [row] = await db.update(adminRoleAssignment).set({ revokedByUserId, revokedAt }).where(eq(adminRoleAssignment.id, id)).returning();
    if (!row) throw new ConfigurationError("admin_role_assignment markRevoked found no row");
    return toRecord(row);
  }
}
