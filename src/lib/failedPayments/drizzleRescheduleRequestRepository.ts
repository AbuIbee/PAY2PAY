import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rescheduleRequest } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { RescheduleRequestRecord, RescheduleRequestRepository } from "./rescheduleRequestService";

type Row = typeof rescheduleRequest.$inferSelect;

function toRecord(row: Row): RescheduleRequestRecord {
  return {
    id: row.id,
    installmentScheduleItemId: row.installmentScheduleItemId,
    agreementId: row.agreementId,
    requestedByProfileKind: row.requestedByProfileKind,
    requestedByProfileId: row.requestedByProfileId,
    currentDueDate: row.currentDueDate,
    requestedDueDate: row.requestedDueDate,
    reason: row.reason,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
  };
}

export class DrizzleRescheduleRequestRepository implements RescheduleRequestRepository {
  async insert(input: {
    installmentScheduleItemId: string;
    agreementId: string;
    requestedByProfileKind: "personal" | "business";
    requestedByProfileId: string;
    currentDueDate: string;
    requestedDueDate: string;
    reason: string | null;
  }): Promise<RescheduleRequestRecord> {
    const db = getDb();
    const [row] = await db.insert(rescheduleRequest).values(input).returning();
    if (!row) throw new ConfigurationError("reschedule_request insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<RescheduleRequestRecord | null> {
    const db = getDb();
    const rows = await db.select().from(rescheduleRequest).where(eq(rescheduleRequest.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByAgreementId(agreementId: string): Promise<RescheduleRequestRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(rescheduleRequest)
      .where(eq(rescheduleRequest.agreementId, agreementId))
      .orderBy(desc(rescheduleRequest.createdAt));
    return rows.map(toRecord);
  }

  async decide(
    id: string,
    status: "approved" | "rejected",
    decidedByUserId: string,
    decidedAt: Date,
    decisionReason: string | null,
  ): Promise<RescheduleRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(rescheduleRequest)
      .set({ status, decidedByUserId, decidedAt, decisionReason })
      .where(eq(rescheduleRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("reschedule_request decide found no row");
    return toRecord(row);
  }
}
