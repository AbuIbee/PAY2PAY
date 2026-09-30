import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { ledgerJournalEntry, ledgerPosting, paymentAttempt, payoutAttempt } from "@/db/schema";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import type { LedgerJournalEntryRecord, LedgerPostingRecord } from "@/lib/ledger/ledgerService";
import type { PayoutAttemptRecord } from "./payoutAttemptRepository";

type PayoutAttemptRow = typeof payoutAttempt.$inferSelect;
type LedgerEntryRow = typeof ledgerJournalEntry.$inferSelect;
type LedgerPostingRow = typeof ledgerPosting.$inferSelect;

function toPayoutRecord(row: PayoutAttemptRow): PayoutAttemptRecord {
  return {
    id: row.id,
    paymentAttemptId: row.paymentAttemptId,
    agreementId: row.agreementId,
    status: row.status,
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

function toPostingRecord(row: LedgerPostingRow): LedgerPostingRecord {
  return { id: row.id, accountId: row.accountId, accountType: row.accountType, direction: row.direction, amountMinorUnits: row.amountMinorUnits };
}

function toEntryRecord(row: LedgerEntryRow, postings: LedgerPostingRow[]): LedgerJournalEntryRecord {
  return {
    id: row.id,
    entryType: row.entryType,
    agreementId: row.agreementId,
    paymentAttemptId: row.paymentAttemptId,
    currency: row.currency,
    reason: row.reason,
    createdAt: row.createdAt,
    postings: postings.map(toPostingRecord),
  };
}

export type ReturnPayoutAtomicResult =
  | { outcome: "returned"; record: PayoutAttemptRecord; ledgerEntry: LedgerJournalEntryRecord }
  /** The attempt was ALREADY `"returned"` when locked/re-read — nothing was written. `record` is the authoritative, pre-existing row. */
  | { outcome: "already_returned"; record: PayoutAttemptRecord };

/**
 * PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-06: atomic payout return).
 * Mirrors `DrizzleAtomicPayoutConfirmer`'s exact shape and rationale (see that class's own doc
 * comment) for the return side of the lifecycle. Closes two gaps a naive `PayoutService.returnPayout`
 * would otherwise have: (1) the ledger correction, `payout_attempt` status change, and
 * `payment_attempt` update being three separate, independently-committed statements with no shared
 * rollback unit; (2) `payment_attempt.payoutCompletedAt` never being cleared after a return, leaving a
 * stale "completed" indicator on a payment whose payout had in fact been reversed.
 */
export interface AtomicPayoutReturner {
  returnAtomically(input: { paymentAttemptId: string; reason: string }): Promise<ReturnPayoutAtomicResult>;
}

/**
 * The same kind of production-safe, no-op-by-default test-only affordance as
 * `AtomicPayoutConfirmerTestHooks` (see that interface's own doc comment). Defaults to `undefined`;
 * every production call site (`new DrizzleAtomicPayoutReturner()`, no second argument) never sets it.
 */
export interface AtomicPayoutReturnerTestHooks {
  /** Awaited immediately after the "payout_returned" ledger entry (and its flipped postings) have been inserted, still inside the open transaction, before payout_attempt is marked returned. */
  afterLedgerCorrection?: () => Promise<void>;
  /** Awaited immediately after payout_attempt has been marked returned, before payment_attempt.payoutCompletedAt is cleared. */
  afterAttemptMarked?: () => Promise<void>;
}

/**
 * ALL FOUR required operations happen inside ONE `db.transaction`:
 *   1. `SELECT ... FROM payout_attempt WHERE payment_attempt_id = ? FOR UPDATE` — identical
 *      concurrency mechanism as the confirmer: a second, concurrent `returnAtomically` call for the
 *      SAME `paymentAttemptId` blocks here until the first commits/rolls back, then re-reads and takes
 *      the `already_returned` branch — never re-posts a second reversing ledger entry.
 *   2. Post (or, defensively, reuse) exactly one `"payout_returned"` ledger entry — the existing
 *      `"payout"` entry's own postings, flipped, replicating `LedgerService.postPayoutReturn`'s logic
 *      against `tx` directly (same deadlock rationale as the confirmer for not calling `LedgerService`
 *      itself here).
 *   3. Mark `payout_attempt` `"returned"`, guarded by `WHERE status = 'confirmed'` — `confirmedAt`/
 *      `providerName`/`providerPayoutReference` are left untouched, preserving the original
 *      confirmation history alongside the new return fields (never overwritten, never cleared).
 *   4. Clear `payment_attempt.payoutCompletedAt` back to `null` — this field is no longer left falsely
 *      indicating an active, completed payout once it has been reversed.
 *
 * Audit recording stays OUTSIDE this transaction, for the identical reason documented on
 * `DrizzleAtomicPayoutConfirmer` — `PayoutService.returnPayout` fires it after this method resolves.
 */
export class DrizzleAtomicPayoutReturner implements AtomicPayoutReturner {
  /** `db` defaults to the shared production singleton solely so `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct connection — mirrors every other atomic coordinator in this codebase. Every production call site (`new DrizzleAtomicPayoutReturner()`, no argument) is unaffected. `hooks` is the same kind of test-only affordance — see `AtomicPayoutReturnerTestHooks`'s own doc comment. */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: AtomicPayoutReturnerTestHooks,
  ) {}

  async returnAtomically(input: { paymentAttemptId: string; reason: string }): Promise<ReturnPayoutAtomicResult> {
    const db = this.db;
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(payoutAttempt).where(eq(payoutAttempt.paymentAttemptId, input.paymentAttemptId)).for("update");
      const row = rows[0];
      if (!row) {
        throw new ValidationError("Cannot return a payout that was never recorded as owed.");
      }
      const current = toPayoutRecord(row);
      if (current.status === "returned") {
        return { outcome: "already_returned", record: current };
      }
      if (current.status !== "confirmed") {
        throw new ValidationError(`Cannot return a payout_attempt in status "${current.status}" — only "confirmed" may be returned.`);
      }

      const existingReturnRows = await tx
        .select()
        .from(ledgerJournalEntry)
        .where(and(eq(ledgerJournalEntry.paymentAttemptId, input.paymentAttemptId), eq(ledgerJournalEntry.entryType, "payout_returned")))
        .limit(1);
      let ledgerEntry: LedgerJournalEntryRecord;
      if (existingReturnRows[0]) {
        const postingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, existingReturnRows[0].id));
        ledgerEntry = toEntryRecord(existingReturnRows[0], postingRows);
      } else {
        const payoutRows = await tx
          .select()
          .from(ledgerJournalEntry)
          .where(and(eq(ledgerJournalEntry.paymentAttemptId, input.paymentAttemptId), eq(ledgerJournalEntry.entryType, "payout")))
          .limit(1);
        const payoutEntry = payoutRows[0];
        if (!payoutEntry) {
          throw new ValidationError("Cannot return a payout that has not been posted.");
        }
        const payoutPostingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, payoutEntry.id));

        const [entryRow] = await tx
          .insert(ledgerJournalEntry)
          .values({ entryType: "payout_returned", agreementId: payoutEntry.agreementId, paymentAttemptId: input.paymentAttemptId, currency: payoutEntry.currency, reason: input.reason })
          .returning();
        if (!entryRow) throw new ConfigurationError("ledger_journal_entry insert returned no row during atomic payout return");
        const flippedPostings = payoutPostingRows.map((p) => ({
          journalEntryId: entryRow.id,
          accountId: p.accountId,
          accountType: p.accountType,
          direction: (p.direction === "debit" ? "credit" : "debit") as "debit" | "credit",
          amountMinorUnits: p.amountMinorUnits,
        }));
        const postingRows = await tx.insert(ledgerPosting).values(flippedPostings).returning();
        ledgerEntry = toEntryRecord(entryRow, postingRows);
      }
      if (this.hooks?.afterLedgerCorrection) await this.hooks.afterLedgerCorrection();

      const returnedAt = new Date();
      const [updatedAttemptRow] = await tx
        .update(payoutAttempt)
        .set({ status: "returned", returnedAt, returnReason: input.reason })
        .where(and(eq(payoutAttempt.id, current.id), eq(payoutAttempt.status, "confirmed")))
        .returning();
      if (!updatedAttemptRow) {
        throw new ConfigurationError("payout_attempt return update affected no row — unexpected concurrent modification under an active row lock");
      }
      if (this.hooks?.afterAttemptMarked) await this.hooks.afterAttemptMarked();

      // Clear the stale "completed" indicator now that this payout has been reversed.
      const [updatedPaymentRow] = await tx
        .update(paymentAttempt)
        .set({ payoutCompletedAt: null, updatedAt: new Date() })
        .where(eq(paymentAttempt.id, input.paymentAttemptId))
        .returning();
      if (!updatedPaymentRow) {
        throw new ConfigurationError("payment_attempt update returned no row during atomic payout return");
      }

      return { outcome: "returned", record: toPayoutRecord(updatedAttemptRow), ledgerEntry };
    });
  }
}
