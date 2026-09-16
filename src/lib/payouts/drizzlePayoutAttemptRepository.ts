import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { payoutAttempt } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PayoutAttemptRecord, PayoutAttemptRepository, PayoutAttemptStatus } from "./payoutAttemptRepository";

type Row = typeof payoutAttempt.$inferSelect;

function toRecord(row: Row): PayoutAttemptRecord {
  return {
    id: row.id,
    paymentAttemptId: row.paymentAttemptId,
    agreementId: row.agreementId,
    status: row.status as PayoutAttemptStatus,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    providerName: row.providerName,
    providerPayoutReference: row.providerPayoutReference,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    returnedAt: row.returnedAt,
    returnReason: row.returnReason,
  };
}

export class DrizzlePayoutAttemptRepository implements PayoutAttemptRepository {
  async insert(input: { paymentAttemptId: string; agreementId: string }): Promise<PayoutAttemptRecord> {
    const db = getDb();
    const [row] = await db.insert(payoutAttempt).values(input).returning();
    if (!row) throw new ConfigurationError("payout_attempt insert returned no row");
    return toRecord(row);
  }

  async findByPaymentAttemptId(paymentAttemptId: string): Promise<PayoutAttemptRecord | null> {
    const db = getDb();
    const rows = await db.select().from(payoutAttempt).where(eq(payoutAttempt.paymentAttemptId, paymentAttemptId)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markConfirmed(id: string, input: { confirmedAt: Date; providerName: string; providerPayoutReference: string }): Promise<PayoutAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(payoutAttempt)
      .set({ status: "confirmed", confirmedAt: input.confirmedAt, providerName: input.providerName, providerPayoutReference: input.providerPayoutReference })
      .where(eq(payoutAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payout_attempt markConfirmed found no row");
    return toRecord(row);
  }

  async markFailed(id: string, input: { failedAt: Date; failureReason: string }): Promise<PayoutAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(payoutAttempt)
      .set({ status: "failed", failedAt: input.failedAt, failureReason: input.failureReason })
      .where(eq(payoutAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payout_attempt markFailed found no row");
    return toRecord(row);
  }

  async markReturned(id: string, input: { returnedAt: Date; returnReason: string }): Promise<PayoutAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(payoutAttempt)
      .set({ status: "returned", returnedAt: input.returnedAt, returnReason: input.returnReason })
      .where(eq(payoutAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payout_attempt markReturned found no row");
    return toRecord(row);
  }
}
