import "server-only";
import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { paymentRetry } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PaymentRetryRecord, PaymentRetryRepository } from "./paymentRetryService";

type Row = typeof paymentRetry.$inferSelect;

function toRecord(row: Row): PaymentRetryRecord {
  return {
    id: row.id,
    originalPaymentAttemptId: row.originalPaymentAttemptId,
    installmentScheduleItemId: row.installmentScheduleItemId,
    agreementId: row.agreementId,
    scheduledFor: row.scheduledFor,
    status: row.status,
    resultingPaymentAttemptId: row.resultingPaymentAttemptId,
    firedAt: row.firedAt,
    canceledAt: row.canceledAt,
    canceledReason: row.canceledReason,
    createdAt: row.createdAt,
  };
}

export class DrizzlePaymentRetryRepository implements PaymentRetryRepository {
  async insert(input: {
    originalPaymentAttemptId: string;
    installmentScheduleItemId: string;
    agreementId: string;
    scheduledFor: Date;
  }): Promise<PaymentRetryRecord> {
    const db = getDb();
    const [row] = await db.insert(paymentRetry).values(input).returning();
    if (!row) throw new ConfigurationError("payment_retry insert returned no row");
    return toRecord(row);
  }

  async findByOriginalPaymentAttemptId(originalPaymentAttemptId: string): Promise<PaymentRetryRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentRetry)
      .where(eq(paymentRetry.originalPaymentAttemptId, originalPaymentAttemptId))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByResultingPaymentAttemptId(resultingPaymentAttemptId: string): Promise<PaymentRetryRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentRetry)
      .where(eq(paymentRetry.resultingPaymentAttemptId, resultingPaymentAttemptId))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findScheduledForInstallment(installmentScheduleItemId: string): Promise<PaymentRetryRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentRetry)
      .where(and(eq(paymentRetry.installmentScheduleItemId, installmentScheduleItemId), eq(paymentRetry.status, "scheduled")))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findDueForFiring(now: Date): Promise<PaymentRetryRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentRetry)
      .where(and(eq(paymentRetry.status, "scheduled"), lte(paymentRetry.scheduledFor, now)));
    return rows.map(toRecord);
  }

  async markFired(id: string, resultingPaymentAttemptId: string, firedAt: Date): Promise<PaymentRetryRecord> {
    const db = getDb();
    const [row] = await db
      .update(paymentRetry)
      .set({ status: "fired", resultingPaymentAttemptId, firedAt })
      .where(eq(paymentRetry.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_retry markFired found no row");
    return toRecord(row);
  }

  async markCanceled(id: string, canceledAt: Date, canceledReason: string): Promise<PaymentRetryRecord> {
    const db = getDb();
    const [row] = await db
      .update(paymentRetry)
      .set({ status: "canceled", canceledAt, canceledReason })
      .where(eq(paymentRetry.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_retry markCanceled found no row");
    return toRecord(row);
  }
}
