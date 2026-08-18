import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { paymentAttempt } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentAttemptStatus, PaymentMethod } from "./paymentService";

type Row = typeof paymentAttempt.$inferSelect;

function toRecord(row: Row): PaymentAttemptRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    payerProfileKind: row.payerProfileKind,
    payerProfileId: row.payerProfileId,
    recipientProfileKind: row.recipientProfileKind,
    recipientProfileId: row.recipientProfileId,
    amountMinorUnits: row.amountMinorUnits,
    currency: row.currency,
    agreementId: row.agreementId,
    status: row.status,
    providerName: row.providerName,
    providerPaymentId: row.providerPaymentId,
    failureReason: row.failureReason,
    payoutCompletedAt: row.payoutCompletedAt,
    payoutInitiatedAt: row.payoutInitiatedAt,
    installmentScheduleItemId: row.installmentScheduleItemId,
    paymentMethod: row.paymentMethod,
    recordedByUserId: row.recordedByUserId,
    recipientConfirmedAt: row.recipientConfirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzlePaymentAttemptRepository implements PaymentAttemptRepository {
  async insertPending(input: {
    idempotencyKey: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    recipientProfileKind: "personal" | "business";
    recipientProfileId: string;
    amountMinorUnits: number;
    currency: string;
    agreementId: string | null;
    providerName: string;
    installmentScheduleItemId?: string | null;
    initialStatus?: PaymentAttemptStatus;
    paymentMethod?: PaymentMethod | null;
    recordedByUserId?: string | null;
  }): Promise<PaymentAttemptRecord> {
    const db = getDb();
    const { initialStatus, ...rest } = input;
    const [row] = await db
      .insert(paymentAttempt)
      .values({ ...rest, status: initialStatus ?? "pending" })
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt insert returned no row");
    return toRecord(row);
  }

  async updateStatus(
    id: string,
    status: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
  ): Promise<PaymentAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(paymentAttempt)
      .set({ status, updatedAt: new Date(), ...fields })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt update returned no row");
    return toRecord(row);
  }

  async confirmManualPayment(id: string, confirmedAt: Date): Promise<PaymentAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(paymentAttempt)
      .set({ recipientConfirmedAt: confirmedAt, updatedAt: new Date() })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt confirmManualPayment found no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<PaymentAttemptRecord | null> {
    const db = getDb();
    const rows = await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PaymentAttemptRecord | null> {
    const db = getDb();
    const rows = await db.select().from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, idempotencyKey)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<PaymentAttemptRecord | null> {
    const db = getDb();
    const rows = await db.select().from(paymentAttempt).where(eq(paymentAttempt.providerPaymentId, providerPaymentId)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markPayoutCompleted(id: string, payoutCompletedAt: Date): Promise<PaymentAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(paymentAttempt)
      .set({ payoutCompletedAt, updatedAt: new Date() })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt markPayoutCompleted found no row");
    return toRecord(row);
  }

  async markPayoutInitiated(id: string, payoutInitiatedAt: Date): Promise<PaymentAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(paymentAttempt)
      .set({ payoutInitiatedAt, updatedAt: new Date() })
      .where(eq(paymentAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_attempt markPayoutInitiated found no row");
    return toRecord(row);
  }

  async findOpenByInstallment(installmentScheduleItemId: string): Promise<PaymentAttemptRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(
        and(
          eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId),
          inArray(paymentAttempt.status, ["pending", "scheduled", "submitted", "processing"]),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listAll(): Promise<PaymentAttemptRecord[]> {
    const db = getDb();
    const rows = await db.select().from(paymentAttempt);
    return rows.map(toRecord);
  }

  async listByAgreementId(agreementId: string): Promise<PaymentAttemptRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.agreementId, agreementId))
      .orderBy(desc(paymentAttempt.createdAt));
    return rows.map(toRecord);
  }
}
