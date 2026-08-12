import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { paymentDispute } from "@/db/schema";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import type { PaymentDisputeCategory, PaymentDisputeRecord, PaymentDisputeRepository } from "./paymentDisputeService";

type Row = typeof paymentDispute.$inferSelect;

function toRecord(row: Row): PaymentDisputeRecord {
  return {
    id: row.id,
    paymentAttemptId: row.paymentAttemptId,
    status: row.status,
    category: row.category,
    explanation: row.explanation,
    claimedByProfileKind: row.claimedByProfileKind,
    claimedByProfileId: row.claimedByProfileId,
    claimedByUserId: row.claimedByUserId,
    preservedMandateReference: row.preservedMandateReference,
    preservedSignatureReference: row.preservedSignatureReference,
    preservedIdentityVerificationReference: row.preservedIdentityVerificationReference,
    ipAddress: row.ipAddress,
    deviceInfo: row.deviceInfo,
    claimedAt: row.claimedAt,
    resolutionNotes: row.resolutionNotes,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzlePaymentDisputeRepository implements PaymentDisputeRepository {
  async insert(input: {
    paymentAttemptId: string;
    category: PaymentDisputeCategory;
    explanation: string;
    claimedByProfileKind: ProfileKind;
    claimedByProfileId: string;
    claimedByUserId: string;
    preservedMandateReference: string | null;
    preservedSignatureReference: string | null;
    preservedIdentityVerificationReference: string | null;
    ipAddress: string | null;
    deviceInfo: unknown;
  }): Promise<PaymentDisputeRecord> {
    const db = getDb();
    const [row] = await db
      .insert(paymentDispute)
      .values({ ...input, deviceInfo: input.deviceInfo as object | null })
      .returning();
    if (!row) throw new ConfigurationError("payment_dispute insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<PaymentDisputeRecord | null> {
    const db = getDb();
    const rows = await db.select().from(paymentDispute).where(eq(paymentDispute.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<PaymentDisputeRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentDispute)
      .where(eq(paymentDispute.paymentAttemptId, paymentAttemptId))
      .orderBy(desc(paymentDispute.createdAt));
    return rows.map(toRecord);
  }

  async recordResolution(
    id: string,
    input: { status: "upheld" | "denied"; resolutionNotes: string | null; resolvedByUserId: string },
  ): Promise<PaymentDisputeRecord> {
    const db = getDb();
    const [row] = await db
      .update(paymentDispute)
      .set({ status: input.status, resolutionNotes: input.resolutionNotes, resolvedByUserId: input.resolvedByUserId, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(paymentDispute.id, id))
      .returning();
    if (!row) throw new ConfigurationError("payment_dispute recordResolution found no row");
    return toRecord(row);
  }
}
