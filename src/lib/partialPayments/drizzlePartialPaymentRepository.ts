import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement, partialPaymentRequest } from "@/db/schema";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import { computePartialPaymentClearedEvidenceWithinTx } from "./partialPaymentClearedEvidenceTx";
import type { PartialPaymentRequestRecord, PartialPaymentRequestRepository, PartialPaymentRequestStatus } from "./partialPaymentService";

/**
 * R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 2): awaited by `expireIfSafe` at each of its own two
 * lock-acquisition points — deterministic proof point for `*.postgres.test.ts` concurrency suites,
 * mirroring this codebase's own `afterAgreementLock`/`afterInstallmentLock` precedent elsewhere
 * (e.g. `DrizzleFailedPaymentRetryCoordinator`). `afterAgreementLock` fires first (the agreement row
 * lock is acquired BEFORE the proposal row lock — see `expireIfSafe`'s own doc comment for why),
 * then `afterProposalLock`.
 *
 * Each hook receives the id of the row it just locked (`agreementId`/`id` respectively).
 * `PartialPaymentService.expireOverdue` calls `expireIfSafe` once PER overdue candidate it finds —
 * so within one `expireOverdue()` sweep, these hooks can fire multiple times, once per candidate row,
 * including rows a concurrency test does not care about (e.g. leftover overdue proposals from an
 * earlier test in the same shared database). Passing the id lets a test's own hook implementation
 * pause ONLY for the specific row it's deliberately racing, and let every other candidate proceed
 * through unpaused — without this, a test hook that unconditionally pauses on first invocation can
 * end up pausing on a completely unrelated row, breaking the test's own deterministic barrier.
 */
export interface PartialPaymentRequestLockTestHooks {
  afterAgreementLock?: (agreementId: string) => Promise<void>;
  afterProposalLock?: (id: string) => Promise<void>;
}

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
  /**
   * R07-style injectability: `db` defaults to the shared production singleton solely so
   * `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct connection (see
   * `DrizzlePaymentTransitionCoordinator`'s own identical precedent). Every production call site
   * (`new DrizzlePartialPaymentRepository()`, no argument) is unaffected. `hooks` is the same kind of
   * test-only affordance, used only by `expireIfSafe`.
   */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: PartialPaymentRequestLockTestHooks,
  ) {}

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
    const db = this.db;
    const [row] = await db.insert(partialPaymentRequest).values(input).returning();
    if (!row) throw new ConfigurationError("partial_payment_request insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<PartialPaymentRequestRecord | null> {
    const db = this.db;
    const rows = await db.select().from(partialPaymentRequest).where(eq(partialPaymentRequest.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForAgreement(agreementId: string): Promise<PartialPaymentRequestRecord[]> {
    const db = this.db;
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
    const db = this.db;
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request updateProposedContent found no row");
    return toRecord(row);
  }

  async updateStatus(id: string, status: PartialPaymentRequestStatus): Promise<PartialPaymentRequestRecord> {
    const db = this.db;
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status, updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request updateStatus found no row");
    return toRecord(row);
  }

  async recordRejection(id: string, reason: string | null): Promise<PartialPaymentRequestRecord> {
    const db = this.db;
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status: "rejected", rejectedReason: reason, rejectedAt: new Date(), updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request recordRejection found no row");
    return toRecord(row);
  }

  async recordApplied(id: string, paymentAttemptId: string): Promise<PartialPaymentRequestRecord> {
    const db = this.db;
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status: "applied", paymentAttemptId, appliedAt: new Date(), updatedAt: new Date() })
      .where(eq(partialPaymentRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("partial_payment_request recordApplied found no row");
    return toRecord(row);
  }

  async applyIfAwaitingPayment(
    id: string,
    paymentAttemptId: string,
  ): Promise<
    | { outcome: "applied"; request: PartialPaymentRequestRecord }
    | { outcome: "already_applied_same"; request: PartialPaymentRequestRecord }
    | { outcome: "already_applied_different"; request: PartialPaymentRequestRecord }
    | { outcome: "not_awaiting_payment"; request: PartialPaymentRequestRecord }
  > {
    const db = this.db;
    // Single conditional UPDATE — atomic by construction (ordinary Postgres row-level MVCC): two
    // concurrent callers racing the SAME request can never both see a row returned here.
    const [row] = await db
      .update(partialPaymentRequest)
      .set({ status: "applied", paymentAttemptId, appliedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(partialPaymentRequest.id, id), eq(partialPaymentRequest.status, "awaiting_payment")))
      .returning();
    if (row) return { outcome: "applied", request: toRecord(row) };

    // Zero rows affected — re-read the authoritative row to classify exactly why, never guess.
    const current = await this.findById(id);
    if (!current) throw new ConfigurationError("partial_payment_request applyIfAwaitingPayment found no row");
    if (current.status === "applied" && current.paymentAttemptId === paymentAttemptId) {
      return { outcome: "already_applied_same", request: current };
    }
    if (current.status === "applied") {
      return { outcome: "already_applied_different", request: current };
    }
    return { outcome: "not_awaiting_payment", request: current };
  }

  async findAwaitingPaymentPastDate(now: Date): Promise<PartialPaymentRequestRecord[]> {
    const db = this.db;
    const boundary = now.toISOString().slice(0, 10);
    const rows = await db
      .select()
      .from(partialPaymentRequest)
      .where(and(eq(partialPaymentRequest.status, "awaiting_payment"), lt(partialPaymentRequest.proposedDate, boundary)));
    return rows.map(toRecord);
  }

  /**
   * R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 2 — EXPIRATION MUST SERIALIZE AGAINST CLEARING).
   * The proposal row's own `FOR UPDATE` lock alone is insufficient: `LedgerService.postPaymentCleared`
   * never touches `partial_payment_request` at all, so it is never blocked by that lock — a real
   * clearing could commit in between a plain evidence read and an unconditional write. Uses the SAME
   * EXISTING agreement-level financial serialization boundary `paid_in_full` completion and
   * `payment_cleared` ledger insertion already rely on: an INSERT into `ledger_journal_entry` takes
   * an implicit `FOR KEY SHARE` lock on the `agreement` row its own `agreement_id` FK references (the
   * SAME mechanism this codebase's own "LOCK-ORDERING NOTE" doc comments describe elsewhere), so an
   * `agreement FOR UPDATE` here genuinely serializes against it. Lock order is
   * `agreement -> proposal` — NEVER reversed, matching every other agreement+installment/proposal
   * transaction in this codebase — then fresh evidence is computed and the expiration decision made,
   * all while STILL holding both locks (never released in between).
   */
  async expireIfSafe(
    id: string,
  ): Promise<
    | { outcome: "expired"; request: PartialPaymentRequestRecord }
    | { outcome: "not_awaiting_payment"; request: PartialPaymentRequestRecord }
    | { outcome: "cleared_skip" }
    | { outcome: "in_flight_skip" }
    | { outcome: "unknown_skip" }
  > {
    return this.db.transaction(async (tx) => {
      // agreementId is immutable once a proposal is created — safe to read without a lock, purely to
      // know WHICH agreement to lock next (never itself a decision input).
      const preRows = await tx.select({ agreementId: partialPaymentRequest.agreementId }).from(partialPaymentRequest).where(eq(partialPaymentRequest.id, id)).limit(1);
      const agreementId = preRows[0]?.agreementId;
      if (!agreementId) throw new ConfigurationError("partial_payment_request expireIfSafe found no row");

      // Agreement lock FIRST — see this method's own doc comment for exactly why this, not the
      // proposal row alone, is the correctness boundary that serializes against ledger clearing.
      const agreementRows = await tx.select({ id: agreement.id }).from(agreement).where(eq(agreement.id, agreementId)).for("update").limit(1);
      if (!agreementRows[0]) throw new ConfigurationError("partial_payment_request expireIfSafe: agreement not found");
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock(agreementId);

      // Row lock held for this transaction's entire remainder — a concurrent `applyIfAwaitingPayment`
      // targeting the SAME row (an ordinary, single-statement UPDATE, no explicit transaction of its
      // own) genuinely blocks on this lock until commit/rollback, via ordinary Postgres row-level
      // locking — no new locking primitive required.
      const rows = await tx.select().from(partialPaymentRequest).where(eq(partialPaymentRequest.id, id)).for("update").limit(1);
      const row = rows[0];
      if (!row) throw new ConfigurationError("partial_payment_request expireIfSafe found no row");
      if (this.hooks?.afterProposalLock) await this.hooks.afterProposalLock(id);
      if (row.status !== "awaiting_payment") return { outcome: "not_awaiting_payment" as const, request: toRecord(row) };

      // Fresh, authoritative clearing evidence — computed WITHIN this same transaction, STILL holding
      // both the agreement and proposal locks, never a separate pre-transaction read (see this
      // method's own doc comment for the exact race this closes). Only NOT_CLEARED may expire.
      const evidence = await computePartialPaymentClearedEvidenceWithinTx(tx, id);
      if (evidence === "cleared") return { outcome: "cleared_skip" as const };
      if (evidence === "in_flight") return { outcome: "in_flight_skip" as const };
      if (evidence === "unknown") return { outcome: "unknown_skip" as const };

      const [updated] = await tx
        .update(partialPaymentRequest)
        .set({ status: "expired", expiredAt: new Date(), updatedAt: new Date() })
        .where(and(eq(partialPaymentRequest.id, id), eq(partialPaymentRequest.status, "awaiting_payment")))
        .returning();
      if (!updated) throw new ConfigurationError("partial_payment_request expireIfSafe: row changed unexpectedly under lock");
      return { outcome: "expired" as const, request: toRecord(updated) };
    });
  }
}
