import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { amendment } from "@/db/schema";
import type { AgreementTerms, FeeAllocation, PartyRole } from "@/lib/agreements/agreementService";
import type { PaymentFrequency } from "@/lib/agreements/schedule";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import type { AmendmentChangeType, AmendmentRecord, AmendmentRepository, AmendmentStatus } from "./amendmentService";

type Row = typeof amendment.$inferSelect;

function toRecord(row: Row): AmendmentRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    changeType: row.changeType,
    status: row.status,
    proposingPartyRole: row.proposingPartyRole,
    proposedByProfileKind: row.proposedByProfileKind,
    proposedByProfileId: row.proposedByProfileId,
    reason: row.reason,
    requestedRelief: row.requestedRelief,
    proposedEffectiveDate: row.proposedEffectiveDate,
    frequency: row.frequency,
    feeAllocation: row.feeAllocation,
    terms: row.terms as AgreementTerms,
    creditorSignedAt: row.creditorSignedAt,
    debtorSignedAt: row.debtorSignedAt,
    signedAt: row.signedAt,
    resultingVersionId: row.resultingVersionId,
    rejectedReason: row.rejectedReason,
    rejectedAt: row.rejectedAt,
    withdrawnReason: row.withdrawnReason,
    withdrawnAt: row.withdrawnAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAmendmentRepository implements AmendmentRepository {
  async insert(input: {
    agreementId: string;
    changeType: AmendmentChangeType;
    proposingPartyRole: PartyRole;
    proposedByProfileKind: ProfileKind;
    proposedByProfileId: string;
    reason: string;
    requestedRelief: string | null;
    proposedEffectiveDate: string | null;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
  }): Promise<AmendmentRecord> {
    const db = getDb();
    const [row] = await db
      .insert(amendment)
      .values({ ...input, terms: input.terms as object })
      .returning();
    if (!row) throw new ConfigurationError("amendment insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AmendmentRecord | null> {
    const db = getDb();
    const rows = await db.select().from(amendment).where(eq(amendment.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForAgreement(agreementId: string): Promise<AmendmentRecord[]> {
    const db = getDb();
    const rows = await db.select().from(amendment).where(eq(amendment.agreementId, agreementId)).orderBy(desc(amendment.createdAt));
    return rows.map(toRecord);
  }

  async updateProposedTerms(
    id: string,
    input: {
      proposingPartyRole: PartyRole;
      proposedByProfileKind: ProfileKind;
      proposedByProfileId: string;
      reason: string;
      requestedRelief: string | null;
      proposedEffectiveDate: string | null;
      frequency: PaymentFrequency;
      feeAllocation: FeeAllocation;
      terms: AgreementTerms;
    },
  ): Promise<AmendmentRecord> {
    const db = getDb();
    const [row] = await db
      .update(amendment)
      .set({ ...input, terms: input.terms as object, updatedAt: new Date() })
      .where(eq(amendment.id, id))
      .returning();
    if (!row) throw new ConfigurationError("amendment updateProposedTerms found no row");
    return toRecord(row);
  }

  async updateStatus(id: string, status: AmendmentStatus): Promise<AmendmentRecord> {
    const db = getDb();
    const [row] = await db.update(amendment).set({ status, updatedAt: new Date() }).where(eq(amendment.id, id)).returning();
    if (!row) throw new ConfigurationError("amendment updateStatus found no row");
    return toRecord(row);
  }

  async recordRejection(id: string, reason: string | null): Promise<AmendmentRecord> {
    const db = getDb();
    const [row] = await db
      .update(amendment)
      .set({ status: "rejected", rejectedReason: reason, rejectedAt: new Date(), updatedAt: new Date() })
      .where(eq(amendment.id, id))
      .returning();
    if (!row) throw new ConfigurationError("amendment recordRejection found no row");
    return toRecord(row);
  }

  async recordWithdrawal(id: string, reason: string | null): Promise<AmendmentRecord> {
    const db = getDb();
    const [row] = await db
      .update(amendment)
      .set({ status: "withdrawn", withdrawnReason: reason, withdrawnAt: new Date(), updatedAt: new Date() })
      .where(eq(amendment.id, id))
      .returning();
    if (!row) throw new ConfigurationError("amendment recordWithdrawal found no row");
    return toRecord(row);
  }

  async recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<AmendmentRecord> {
    const db = getDb();
    const column = role === "creditor" ? { creditorSignedAt: signedAt } : { debtorSignedAt: signedAt };
    const [row] = await db
      .update(amendment)
      .set({ ...column, updatedAt: new Date() })
      .where(eq(amendment.id, id))
      .returning();
    if (!row) throw new ConfigurationError("amendment recordSignature found no row");
    return toRecord(row);
  }

  async recordApplied(id: string, resultingVersionId: string): Promise<AmendmentRecord> {
    const db = getDb();
    const [row] = await db
      .update(amendment)
      .set({ status: "applied", resultingVersionId, updatedAt: new Date() })
      .where(eq(amendment.id, id))
      .returning();
    if (!row) throw new ConfigurationError("amendment recordApplied found no row");
    return toRecord(row);
  }
}
