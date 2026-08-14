import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminRestriction } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AdminRestrictionRecord, AdminRestrictionRepository, AdminRestrictionType } from "./adminRestrictionService";

type Row = typeof adminRestriction.$inferSelect;

function toRecord(row: Row): AdminRestrictionRecord {
  return {
    id: row.id,
    restrictionType: row.restrictionType as AdminRestrictionType,
    targetResourceType: row.targetResourceType,
    targetResourceId: row.targetResourceId,
    reason: row.reason,
    caseReference: row.caseReference,
    placedByUserId: row.placedByUserId,
    placedAt: row.placedAt,
    liftedByUserId: row.liftedByUserId,
    liftedAt: row.liftedAt,
  };
}

export class DrizzleAdminRestrictionRepository implements AdminRestrictionRepository {
  async insert(input: {
    restrictionType: AdminRestrictionType;
    targetResourceType: string;
    targetResourceId: string;
    reason: string;
    caseReference: string | null;
    placedByUserId: string;
  }): Promise<AdminRestrictionRecord> {
    const db = getDb();
    const [row] = await db.insert(adminRestriction).values(input).returning();
    if (!row) throw new ConfigurationError("admin_restriction insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AdminRestrictionRecord | null> {
    const db = getDb();
    const rows = await db.select().from(adminRestriction).where(eq(adminRestriction.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findActive(targetResourceType: string, targetResourceId: string, restrictionType: AdminRestrictionType): Promise<AdminRestrictionRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(adminRestriction)
      .where(
        and(
          eq(adminRestriction.targetResourceType, targetResourceType),
          eq(adminRestriction.targetResourceId, targetResourceId),
          eq(adminRestriction.restrictionType, restrictionType),
          isNull(adminRestriction.liftedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForTarget(targetResourceType: string, targetResourceId: string): Promise<AdminRestrictionRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(adminRestriction)
      .where(and(eq(adminRestriction.targetResourceType, targetResourceType), eq(adminRestriction.targetResourceId, targetResourceId)));
    return rows.map(toRecord);
  }

  async markLifted(id: string, liftedByUserId: string, liftedAt: Date): Promise<AdminRestrictionRecord> {
    const db = getDb();
    const [row] = await db.update(adminRestriction).set({ liftedByUserId, liftedAt }).where(eq(adminRestriction.id, id)).returning();
    if (!row) throw new ConfigurationError("admin_restriction markLifted found no row");
    return toRecord(row);
  }
}
