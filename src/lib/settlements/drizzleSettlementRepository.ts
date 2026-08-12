import "server-only";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { settlementPayment, settlementProposal } from "@/db/schema";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import type {
  NormalizedSettlementTerms,
  SettlementFailureConsequence,
  SettlementPaymentRepository,
  SettlementProposalRecord,
  SettlementProposalRepository,
} from "./settlementService";

type Row = typeof settlementProposal.$inferSelect;

function toRecord(row: Row): SettlementProposalRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    status: row.status,
    proposingPartyRole: row.proposingPartyRole,
    proposedByProfileKind: row.proposedByProfileKind,
    proposedByProfileId: row.proposedByProfileId,
    preSettlementBalanceMinorUnits: row.preSettlementBalanceMinorUnits,
    settlementAmountMinorUnits: row.settlementAmountMinorUnits,
    forgivenAmountMinorUnits: row.forgivenAmountMinorUnits,
    deadline: row.deadline,
    paymentMode: row.paymentMode,
    failureConsequence: row.failureConsequence,
    failureConsequenceStatedAmountMinorUnits: row.failureConsequenceStatedAmountMinorUnits,
    rejectedReason: row.rejectedReason,
    rejectedAt: row.rejectedAt,
    acceptedAt: row.acceptedAt,
    completedAt: row.completedAt,
    resolvedConsequence: row.resolvedConsequence,
    resolvedRestoredBalanceMinorUnits: row.resolvedRestoredBalanceMinorUnits,
    resolvedForgivenAmountMinorUnits: row.resolvedForgivenAmountMinorUnits,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleSettlementRepository implements SettlementProposalRepository {
  async insert(
    input: { agreementId: string; proposingPartyRole: PartyRole; proposedByProfileKind: ProfileKind; proposedByProfileId: string } & NormalizedSettlementTerms,
  ): Promise<SettlementProposalRecord> {
    const db = getDb();
    const [row] = await db
      .insert(settlementProposal)
      .values({ ...input, failureConsequenceStatedAmountMinorUnits: input.failureConsequenceStatedAmountMinorUnits ?? null })
      .returning();
    if (!row) throw new ConfigurationError("settlement_proposal insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<SettlementProposalRecord | null> {
    const db = getDb();
    const rows = await db.select().from(settlementProposal).where(eq(settlementProposal.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForAgreement(agreementId: string): Promise<SettlementProposalRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(settlementProposal)
      .where(eq(settlementProposal.agreementId, agreementId))
      .orderBy(desc(settlementProposal.createdAt));
    return rows.map(toRecord);
  }

  async updateProposedContent(
    id: string,
    input: { proposingPartyRole: PartyRole; proposedByProfileKind: ProfileKind; proposedByProfileId: string } & NormalizedSettlementTerms,
  ): Promise<SettlementProposalRecord> {
    const db = getDb();
    const [row] = await db
      .update(settlementProposal)
      .set({ ...input, failureConsequenceStatedAmountMinorUnits: input.failureConsequenceStatedAmountMinorUnits ?? null, updatedAt: new Date() })
      .where(eq(settlementProposal.id, id))
      .returning();
    if (!row) throw new ConfigurationError("settlement_proposal updateProposedContent found no row");
    return toRecord(row);
  }

  async recordAccepted(id: string): Promise<SettlementProposalRecord> {
    const db = getDb();
    const [row] = await db
      .update(settlementProposal)
      .set({ status: "awaiting_payment", acceptedAt: new Date(), updatedAt: new Date() })
      .where(eq(settlementProposal.id, id))
      .returning();
    if (!row) throw new ConfigurationError("settlement_proposal recordAccepted found no row");
    return toRecord(row);
  }

  async recordRejection(id: string, reason: string | null): Promise<SettlementProposalRecord> {
    const db = getDb();
    const [row] = await db
      .update(settlementProposal)
      .set({ status: "rejected", rejectedReason: reason, rejectedAt: new Date(), updatedAt: new Date() })
      .where(eq(settlementProposal.id, id))
      .returning();
    if (!row) throw new ConfigurationError("settlement_proposal recordRejection found no row");
    return toRecord(row);
  }

  async recordCompleted(id: string): Promise<SettlementProposalRecord> {
    const db = getDb();
    const [row] = await db
      .update(settlementProposal)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(settlementProposal.id, id))
      .returning();
    if (!row) throw new ConfigurationError("settlement_proposal recordCompleted found no row");
    return toRecord(row);
  }

  async recordFailureConsequence(
    id: string,
    input: {
      resolvedConsequence: SettlementFailureConsequence;
      resolvedRestoredBalanceMinorUnits: number | null;
      resolvedForgivenAmountMinorUnits: number | null;
    },
  ): Promise<SettlementProposalRecord> {
    const db = getDb();
    const [row] = await db
      .update(settlementProposal)
      .set({ status: "failure_consequence_applied", ...input, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(settlementProposal.id, id))
      .returning();
    if (!row) throw new ConfigurationError("settlement_proposal recordFailureConsequence found no row");
    return toRecord(row);
  }

  async findAwaitingPaymentPastDeadline(now: Date): Promise<SettlementProposalRecord[]> {
    const db = getDb();
    const boundary = now.toISOString().slice(0, 10);
    const rows = await db
      .select()
      .from(settlementProposal)
      .where(and(eq(settlementProposal.status, "awaiting_payment"), lt(settlementProposal.deadline, boundary)));
    return rows.map(toRecord);
  }
}

export class DrizzleSettlementPaymentRepository implements SettlementPaymentRepository {
  async insert(input: { settlementProposalId: string; paymentAttemptId: string; amountMinorUnits: number }): Promise<void> {
    const db = getDb();
    await db.insert(settlementPayment).values(input);
  }

  async isPaymentLinked(paymentAttemptId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db.select().from(settlementPayment).where(eq(settlementPayment.paymentAttemptId, paymentAttemptId)).limit(1);
    return rows.length > 0;
  }

  async sumForSettlement(settlementProposalId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${settlementPayment.amountMinorUnits}), 0)` })
      .from(settlementPayment)
      .where(eq(settlementPayment.settlementProposalId, settlementProposalId));
    return Number(rows[0]?.total ?? 0);
  }
}
