import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { retentionHold } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { RetentionHoldRecord, RetentionHoldRepository, RetentionHoldType } from "./retentionHoldService";

type Row = typeof retentionHold.$inferSelect;

function toRecord(row: Row): RetentionHoldRecord {
  return {
    id: row.id,
    targetResourceType: row.targetResourceType,
    targetResourceId: row.targetResourceId,
    holdType: row.holdType as RetentionHoldType,
    reason: row.reason,
    placedByUserId: row.placedByUserId,
    placedAt: row.placedAt,
    releasedByUserId: row.releasedByUserId,
    releasedAt: row.releasedAt,
  };
}

export class DrizzleRetentionHoldRepository implements RetentionHoldRepository {
  async insert(input: { targetResourceType: string; targetResourceId: string; holdType: RetentionHoldType; reason: string; placedByUserId: string }): Promise<RetentionHoldRecord> {
    const db = getDb();
    const [row] = await db.insert(retentionHold).values(input).returning();
    if (!row) throw new ConfigurationError("retention_hold insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<RetentionHoldRecord | null> {
    const db = getDb();
    const rows = await db.select().from(retentionHold).where(eq(retentionHold.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForTarget(targetResourceType: string, targetResourceId: string): Promise<RetentionHoldRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(retentionHold)
      .where(and(eq(retentionHold.targetResourceType, targetResourceType), eq(retentionHold.targetResourceId, targetResourceId)));
    return rows.map(toRecord);
  }

  async listActive(): Promise<RetentionHoldRecord[]> {
    const db = getDb();
    const rows = await db.select().from(retentionHold).where(isNull(retentionHold.releasedAt));
    return rows.map(toRecord);
  }

  async markReleased(id: string, releasedByUserId: string, releasedAt: Date): Promise<RetentionHoldRecord> {
    const db = getDb();
    const [row] = await db.update(retentionHold).set({ releasedByUserId, releasedAt }).where(eq(retentionHold.id, id)).returning();
    if (!row) throw new ConfigurationError("retention_hold markReleased found no row");
    return toRecord(row);
  }
}
