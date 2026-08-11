import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { reconciliationException } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { ReconciliationExceptionRecord, ReconciliationExceptionRepository, ReconciliationExceptionType } from "./reconciliationService";

type Row = typeof reconciliationException.$inferSelect;

function toRecord(row: Row): ReconciliationExceptionRecord {
  return {
    id: row.id,
    exceptionType: row.exceptionType,
    paymentAttemptId: row.paymentAttemptId,
    providerEventId: row.providerEventId,
    details: row.details,
    status: row.status,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
    resolutionReason: row.resolutionReason,
  };
}

export class DrizzleReconciliationExceptionRepository implements ReconciliationExceptionRepository {
  async findOpen(
    exceptionType: ReconciliationExceptionType,
    paymentAttemptId: string | null,
    providerEventId: string | null,
  ): Promise<ReconciliationExceptionRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(reconciliationException)
      .where(
        and(
          eq(reconciliationException.exceptionType, exceptionType),
          eq(reconciliationException.status, "open"),
          paymentAttemptId ? eq(reconciliationException.paymentAttemptId, paymentAttemptId) : isNull(reconciliationException.paymentAttemptId),
          providerEventId ? eq(reconciliationException.providerEventId, providerEventId) : isNull(reconciliationException.providerEventId),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async insert(input: {
    exceptionType: ReconciliationExceptionType;
    paymentAttemptId: string | null;
    providerEventId: string | null;
    details: unknown;
  }): Promise<ReconciliationExceptionRecord> {
    const db = getDb();
    const [row] = await db.insert(reconciliationException).values(input).returning();
    if (!row) throw new ConfigurationError("reconciliation_exception insert returned no row");
    return toRecord(row);
  }

  async listOpen(): Promise<ReconciliationExceptionRecord[]> {
    const db = getDb();
    const rows = await db.select().from(reconciliationException).where(eq(reconciliationException.status, "open"));
    return rows.map(toRecord);
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<ReconciliationExceptionRecord[]> {
    const db = getDb();
    const rows = await db.select().from(reconciliationException).where(eq(reconciliationException.paymentAttemptId, paymentAttemptId));
    return rows.map(toRecord);
  }

  async resolve(id: string, resolvedByUserId: string, resolutionReason: string): Promise<ReconciliationExceptionRecord> {
    const db = getDb();
    const [row] = await db
      .update(reconciliationException)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedByUserId, resolutionReason })
      .where(eq(reconciliationException.id, id))
      .returning();
    if (!row) throw new ConfigurationError("reconciliation_exception resolve found no row");
    return toRecord(row);
  }
}
