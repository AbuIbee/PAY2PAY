import "server-only";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { settlementPayment, settlementProposal } from "@/db/schema";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import type {
  NormalizedSettlementTerms,
  RecordWithinSettlementCeilingResult,
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

/**
 * R11 PASS B2: the same kind of production-safe, no-op-by-default test-only affordance as
 * `AtomicManualPaymentPosterTestHooks`/`InstallmentReservationTestHooks` — lets a `*.postgres.test.ts`
 * suite deterministically pause this transaction the instant it genuinely holds the
 * `settlement_proposal` row lock, long enough to prove a second, concurrently-racing recording attempt
 * against the SAME settlement queues behind it. Defaults to `undefined`; every production call site
 * (`new DrizzleSettlementPaymentRepository()`, no argument) never sets it.
 */
export interface SettlementPaymentTestHooks {
  /** Awaited immediately after the `settlement_proposal` row lock has been GRANTED — before the duplicate-link check, the sum, or the insert. */
  afterProposalLock?: () => Promise<void>;
}

/**
 * R11 PASS B2 (Check 5 — MAKE SCHEDULED SETTLEMENT CEILING ATOMIC): real implementation of
 * `SettlementPaymentRepository` — see that interface's own doc comment for the concurrent-overpayment
 * race `recordWithinSettlementCeiling` closes. Mirrors `DrizzleAtomicManualPaymentPoster`'s established
 * "single, hand-written transaction, writing directly against raw Drizzle table objects" pattern.
 */
export class DrizzleSettlementPaymentRepository implements SettlementPaymentRepository {
  /**
   * R11 PASS B2: `db` is injectable (defaulting to the shared production singleton) so
   * `*.postgres.test.ts` concurrency suites can hand two instances of this class two genuinely
   * distinct PostgreSQL connections — mirrors `DrizzleAtomicManualPaymentPoster`'s identical
   * precedent. Every production call site (`new DrizzleSettlementPaymentRepository()`, no argument)
   * is unaffected.
   */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: SettlementPaymentTestHooks,
  ) {}

  async recordWithinSettlementCeiling(input: {
    settlementProposalId: string;
    paymentAttemptId: string;
    amountMinorUnits: number;
  }): Promise<RecordWithinSettlementCeilingResult> {
    const db = this.db;
    return db.transaction(async (tx) => {
      // The settlement_proposal row lock is THE serialization point — a second, concurrent call for
      // the SAME settlement blocks here until this transaction commits or rolls back, then re-reads
      // the now-current collected total below. Never a separate "read sum, compare, later insert"
      // sequence outside this lock, which two genuinely concurrent payments could both pass.
      const proposalRows = await tx.select().from(settlementProposal).where(eq(settlementProposal.id, input.settlementProposalId)).for("update").limit(1);
      if (this.hooks?.afterProposalLock) await this.hooks.afterProposalLock();
      const proposalRow = proposalRows[0];
      if (!proposalRow || proposalRow.status !== "awaiting_payment") {
        return { outcome: "not_awaiting_payment" };
      }

      const linkedRows = await tx.select({ id: settlementPayment.id }).from(settlementPayment).where(eq(settlementPayment.paymentAttemptId, input.paymentAttemptId)).limit(1);
      if (linkedRows[0]) {
        return { outcome: "already_linked" };
      }

      const sumRows = await tx
        .select({ total: sql<string>`coalesce(sum(${settlementPayment.amountMinorUnits}), 0)` })
        .from(settlementPayment)
        .where(eq(settlementPayment.settlementProposalId, input.settlementProposalId));
      const existingTotal = Number(sumRows[0]?.total ?? 0);
      const newTotal = existingTotal + input.amountMinorUnits;
      if (newTotal > proposalRow.settlementAmountMinorUnits) {
        return { outcome: "would_exceed_settlement_amount", totalCollectedMinorUnits: existingTotal };
      }

      await tx.insert(settlementPayment).values(input);
      return { outcome: "recorded", totalCollectedMinorUnits: newTotal };
    });
  }

  async sumForSettlement(settlementProposalId: string): Promise<number> {
    const db = this.db;
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${settlementPayment.amountMinorUnits}), 0)` })
      .from(settlementPayment)
      .where(eq(settlementPayment.settlementProposalId, settlementProposalId));
    return Number(rows[0]?.total ?? 0);
  }
}
