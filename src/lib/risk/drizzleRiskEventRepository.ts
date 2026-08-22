import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { riskEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { RiskEventRecord, RiskEventRepository, RiskSignalOutcome, RiskSignalSeverity, RiskSignalType } from "./riskEventService";

type Row = typeof riskEvent.$inferSelect;

function toRecord(row: Row): RiskEventRecord {
  return {
    id: row.id,
    userId: row.userId,
    signalType: row.signalType,
    severity: row.severity,
    outcome: row.outcome,
    relatedResourceType: row.relatedResourceType,
    relatedResourceId: row.relatedResourceId,
    detail: (row.detail as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    reviewState: row.reviewState,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt,
  };
}

export class DrizzleRiskEventRepository implements RiskEventRepository {
  async insert(input: {
    userId: string;
    signalType: RiskSignalType;
    severity: RiskSignalSeverity;
    outcome: RiskSignalOutcome;
    relatedResourceType: string | null;
    relatedResourceId: string | null;
    detail: Record<string, unknown> | null;
  }): Promise<RiskEventRecord> {
    const db = getDb();
    const [row] = await db.insert(riskEvent).values(input).returning();
    if (!row) throw new ConfigurationError("risk_event insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<RiskEventRecord | null> {
    const db = getDb();
    const rows = await db.select().from(riskEvent).where(eq(riskEvent.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForUser(userId: string): Promise<RiskEventRecord[]> {
    const db = getDb();
    const rows = await db.select().from(riskEvent).where(eq(riskEvent.userId, userId)).orderBy(desc(riskEvent.createdAt));
    return rows.map(toRecord);
  }

  async listRecent(input: { openOnly: boolean; limit: number }): Promise<RiskEventRecord[]> {
    const db = getDb();
    const rows = input.openOnly
      ? await db.select().from(riskEvent).where(eq(riskEvent.reviewState, "open")).orderBy(desc(riskEvent.createdAt)).limit(input.limit)
      : await db.select().from(riskEvent).orderBy(desc(riskEvent.createdAt)).limit(input.limit);
    return rows.map(toRecord);
  }

  async markReviewed(id: string, reviewedByUserId: string, reviewState: "reviewed" | "dismissed"): Promise<RiskEventRecord> {
    const db = getDb();
    const [row] = await db
      .update(riskEvent)
      .set({ reviewState, reviewedByUserId, reviewedAt: new Date() })
      .where(eq(riskEvent.id, id))
      .returning();
    if (!row) throw new ConfigurationError("risk_event markReviewed found no row");
    return toRecord(row);
  }
}
