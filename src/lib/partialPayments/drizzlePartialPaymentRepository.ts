import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { partialPaymentRequest } from "@/db/schema";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import type { PartialPaymentRequestRecord, PartialPaymentRequestRepository, PartialPaymentRequestStatus } from "./partialPaymentService";

type Row = typeof partialPaymentRequest.$inferSelect;

function toRecord(row: Row): PartialPaymentRequestRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    installmentScheduleItemId: row.installmentScheduleItemId,
    status: row.status,
    proposingPartyRole: row.proposingPartyRole,
    proposedByProfileKind: row.proposedByProfileKind,
    proposedByProfileId: row.proposedByProfileId,
    proposedAmountMinorUnits: row.proposedAmountMinorUnits,
    proposedDate: row.proposedDate,
    explanation: row.explanation,
    remainderTreatment: row.remainderTreatment,
    rejectedReason: row.rejectedReason,
    rejectedAt: row.rejectedAt,
    paymentAttemptId: row.paymentAttemptId,
    appliedAt: row.appliedAt,
    expiredAt: row.expiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzlePartialPaymentRepository implements PartialPaymentRequestRepository {
  async insert(input: {
    agreementId: string;
    installmentScheduleItemId: string | null;
    proposingPartyRole: PartyRole;
    proposedByProfileKind: ProfileKind;
    proposedByProfileId: string;
    proposedAmountMinorUnits: number;
    proposedDate: string;
    explanation: string | null;
    remainderTreatment: string | null;
  }): Promise<PartialPaymentRequestRecord> {
    const db = getDb();
    const [row] = await db.insert(partialPaymentRequest).values(input).returning();
    if (!row) throw new ConfigurationError("partial_payment_request insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<PartialPaymentRequestRecord | null> {
    const db = getDb();
    const rows = await db.select().from(partialPaymentRequest).where(eq(partialPaymentRequest.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForAgreement(agreementId: string): Promise<PartialPaymentRequestRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(partialPaymentRequest)
      .where(eq(partialPaymentRequest.agreementId, agreementId))
      .orderBy(desc(partialPaymentRequest.createdAt));
    return rows.map(toRecord);
  }

  async updateProposedContent(
    id: string,
    input: {
      proposingPartyRole: PartyRole;
      proposedByProfileKind: ProfileKind;
      proposedByProfileId: string;
      proposedAmountMinorUnits: number;
      proposedDate: string;
      explanation: string | null;
      remainderTreatment: string | null;
    },
  ): Promise<PartialPaymentRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request updateProposedContent found no row");
    return toRecord(row);
  }

  async updateStatus(id: string, status: PartialPaymentRequestStatus): Promise<PartialPaymentRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status, updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request updateStatus found no row");
    return toRecord(row);
  }

  async recordRejection(id: string, reason: string | null): Promise<PartialPaymentRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status: "rejected", rejectedReason: reason, rejectedAt: new Date(), updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request recordRejection found no row");
    return toRecord(row);
  }

  async recordApplied(id: string, paymentAttemptId: string): Promise<PartialPaymentRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status: "applied", paymentAttemptId, appliedAt: new Date(), updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request recordApplied found no row");
    return toRecord(row);
  }

  async recordExpired(id: string): Promise<PartialPaymentRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status: "expired", expiredAt: new Date(), updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request recordExpired found no row");
    return toRecord(row);
  }

  async findAwaitingPaymentPastDate(now: Date): Promise<PartialPaymentRequestRecord[]> {
    const db = getDb();
    const boundary = now.toISOString().slice(0, 10);
    const rows = await db
      .select()
      .from(partialPaymentRequest)
      .where(and(eq(partialPaymentRequest.status, "awaiting_payment"), lt(partialPaymentRequest.proposedDate, boundary)));
    return rows.map(toRecord);
  }
}
