import "server-only";
import { eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { appeal } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AppealDecision, AppealRecord, AppealRepository, AppealStatus } from "./appealService";

type Row = typeof appeal.$inferSelect;

function toRecord(row: Row): AppealRecord {
  return {
    id: row.id,
    appealingUserId: row.appealingUserId,
    targetResourceType: row.targetResourceType,
    targetResourceId: row.targetResourceId,
    originalDecisionSummary: row.originalDecisionSummary,
    originalDecisionByUserId: row.originalDecisionByUserId,
    evidenceDescription: row.evidenceDescription,
    status: row.status as AppealStatus,
    reviewerUserId: row.reviewerUserId,
    decision: row.decision as AppealDecision | null,
    rationale: row.rationale,
    decidedAt: row.decidedAt,
    notifiedAt: row.notifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAppealRepository implements AppealRepository {
  async insert(input: {
    appealingUserId: string;
    targetResourceType: string;
    targetResourceId: string;
    originalDecisionSummary: string;
    originalDecisionByUserId: string | null;
    evidenceDescription: string | null;
  }): Promise<AppealRecord> {
    const db = getDb();
    const [row] = await db.insert(appeal).values(input).returning();
    if (!row) throw new ConfigurationError("appeal insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AppealRecord | null> {
    const db = getDb();
    const rows = await db.select().from(appeal).where(eq(appeal.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForUser(appealingUserId: string): Promise<AppealRecord[]> {
    const db = getDb();
    const rows = await db.select().from(appeal).where(eq(appeal.appealingUserId, appealingUserId));
    return rows.map(toRecord);
  }

  async listOpen(): Promise<AppealRecord[]> {
    const db = getDb();
    const rows = await db.select().from(appeal).where(ne(appeal.status, "decided"));
    return rows.map(toRecord);
  }

  async assignReviewer(id: string, reviewerUserId: string): Promise<AppealRecord> {
    const db = getDb();
    const [row] = await db
      .update(appeal)
      .set({ reviewerUserId, status: "under_review", updatedAt: new Date() })
      .where(eq(appeal.id, id))
      .returning();
    if (!row) throw new ConfigurationError("appeal assignReviewer found no row");
    return toRecord(row);
  }

  async recordDecision(id: string, input: { decision: AppealDecision; rationale: string; decidedAt: Date }): Promise<AppealRecord> {
    const db = getDb();
    const [row] = await db
      .update(appeal)
      .set({ status: "decided", decision: input.decision, rationale: input.rationale, decidedAt: input.decidedAt, updatedAt: new Date() })
      .where(eq(appeal.id, id))
      .returning();
    if (!row) throw new ConfigurationError("appeal recordDecision found no row");
    return toRecord(row);
  }

  async markNotified(id: string, notifiedAt: Date): Promise<AppealRecord> {
    const db = getDb();
    const [row] = await db.update(appeal).set({ notifiedAt, updatedAt: new Date() }).where(eq(appeal.id, id)).returning();
    if (!row) throw new ConfigurationError("appeal markNotified found no row");
    return toRecord(row);
  }
}
