import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { ledgerAccount, ledgerJournalEntry, ledgerPosting, paymentAttempt, payoutAttempt } from "@/db/schema";
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

export type ConfirmPayoutAtomicResult =
  | { outcome: "confirmed"; record: PayoutAttemptRecord; payoutCompletedAt: Date; ledgerEntry: LedgerJournalEntryRecord }
  /** The attempt was ALREADY `"confirmed"` when locked/re-read — nothing was written. `record` is the authoritative, pre-existing row. */
  | { outcome: "already_confirmed"; record: PayoutAttemptRecord };

/**
 * PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-06: atomic payout
 * confirmation). Closes the gap in `PayoutService.confirmPayout`'s naive implementation, which would
 * otherwise perform the payout_attempt claim, ledger posting, and `payment_attempt.payoutCompletedAt`
 * write as three separate, independently-committed statements — a crash between them is reachable and
 * would leave the ledger reflecting a payout that `payout_attempt`/`payment_attempt` do not yet show.
 */
export interface AtomicPayoutConfirmer {
  confirmAtomically(input: { paymentAttemptId: string; providerName: string; providerPayoutReference: string }): Promise<ConfirmPayoutAtomicResult>;
}

/**
 * The same kind of production-safe, no-op-by-default test-only affordance as
 * `AtomicManualPaymentPosterTestHooks`/`LedgerJournalEntryInsertTestHooks` (see those interfaces' own
 * doc comments) — lets a `*.postgres.test.ts` suite force a rollback partway through
 * `confirmAtomically`'s transaction to prove every write within it is genuinely one atomic unit.
 * Defaults to `undefined`; every production call site (`new DrizzleAtomicPayoutConfirmer()`, no second
 * argument) never sets it.
 */
export interface AtomicPayoutConfirmerTestHooks {
  /** Awaited immediately after the "payout" ledger entry (and its postings) have been inserted, still inside the open transaction, before payout_attempt is marked confirmed. */
  afterLedgerPost?: () => Promise<void>;
  /** Awaited immediately after payout_attempt has been marked confirmed, before payment_attempt.payoutCompletedAt is set. */
  afterAttemptMarked?: () => Promise<void>;
}

/**
 * Mirrors `DrizzleAtomicManualPaymentPoster`'s established "single, hand-written multi-table
 * transaction, writing directly against raw Drizzle table objects so every statement shares the same
 * `tx`" pattern exactly, for the identical reason documented there:
 * `DrizzlePayoutAttemptRepository`/`DrizzleLedgerJournalEntryRepository`/`DrizzlePaymentAttemptRepository`
 * each open their own `getDb()` connection and are deliberately left untouched (still correct, still
 * used for every other read/write path — `recordPayoutOwed`/`failPayout`/`getPayoutStatus` never go
 * through this class).
 *
 * ALL FOUR of the required operations happen inside ONE `db.transaction`, so a crash/error at any
 * point rolls back everything already written in this call — no partial state is ever observable:
 *   1. `SELECT ... FROM payout_attempt WHERE payment_attempt_id = ? FOR UPDATE` — this row lock IS the
 *      concurrency mechanism. A second, concurrent `confirmAtomically` call for the SAME
 *      `paymentAttemptId` blocks here until the first transaction commits or rolls back, then re-reads
 *      the now-current row and takes the `already_confirmed` branch below — it never re-executes the
 *      ledger/mark logic a second time. Exactly one caller ever performs the real confirmation; any
 *      others observe its already-applied result.
 *   2. Post the `"payout"` ledger entry + its two balanced postings (replicates
 *      `LedgerService.postPayout`'s validation — payment must have cleared, must not have been
 *      refunded/reversed/disputed, must have a creditor leg to pay out — against `tx` directly, since
 *      `LedgerService.postPayout` opens its OWN nested `db.transaction`, which would deadlock against
 *      this outer transaction on the shared `max: 1`-pooled connection, per
 *      `failedPaymentRetryCoordinator.ts`'s own documented precedent for why nesting is unsafe here).
 *   3. Mark `payout_attempt` `"confirmed"`, guarded by `WHERE status = 'pending'` (redundant with the
 *      row lock above, but a defensive zero-row check exactly like
 *      `DrizzlePaymentTransitionCoordinator`'s own `.returning()`-checked marker update).
 *   4. Set `payment_attempt.payoutCompletedAt`.
 *
 * Audit recording is deliberately NOT part of this transaction — `AuditService.record`'s own
 * hash-chaining append opens its OWN separate `db.transaction` plus a transaction-scoped advisory
 * lock serializing the whole chain; nesting that inside this transaction would hit the identical
 * deadlock risk as calling `LedgerService.postPayout` directly would. `PayoutService.confirmPayout`
 * fires the audit record itself, immediately after this method resolves.
 */
export class DrizzleAtomicPayoutConfirmer implements AtomicPayoutConfirmer {
  /** `db` defaults to the shared production singleton solely so `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct connection — mirrors every other atomic coordinator in this codebase. Every production call site (`new DrizzleAtomicPayoutConfirmer()`, no argument) is unaffected. `hooks` is the same kind of test-only affordance — see `AtomicPayoutConfirmerTestHooks`'s own doc comment. */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: AtomicPayoutConfirmerTestHooks,
  ) {}

  async confirmAtomically(input: { paymentAttemptId: string; providerName: string; providerPayoutReference: string }): Promise<ConfirmPayoutAtomicResult> {
    const db = this.db;
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(payoutAttempt).where(eq(payoutAttempt.paymentAttemptId, input.paymentAttemptId)).for("update");
      const row = rows[0];
      if (!row) {
        throw new ValidationError("Cannot confirm a payout that was never recorded as owed.");
      }
      const current = toPayoutRecord(row);
      if (current.status === "confirmed") {
        return { outcome: "already_confirmed", record: current };
      }
      if (current.status !== "pending") {
        throw new ValidationError(`Cannot confirm a payout_attempt in status "${current.status}" — only "pending" may be confirmed.`);
      }

      // Step 2: post (or, defensively, reuse an already-posted) "payout" ledger entry — the row lock
      // above already guarantees no OTHER confirmAtomically call can reach this concurrently for the
      // same payout_attempt, so `existingEntry` here is only ever hit by a genuinely retried call after
      // this same transaction previously failed after this insert but before commit is impossible
      // (this insert is inside the same transaction as the commit) — kept anyway as the same
      // idempotent-insert defensive shape `LedgerService.insertIdempotently` uses everywhere else.
      const existingEntryRows = await tx
        .select()
        .from(ledgerJournalEntry)
        .where(and(eq(ledgerJournalEntry.paymentAttemptId, input.paymentAttemptId), eq(ledgerJournalEntry.entryType, "payout")))
        .limit(1);
      let ledgerEntry: LedgerJournalEntryRecord;
      if (existingEntryRows[0]) {
        const postingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, existingEntryRows[0].id));
        ledgerEntry = toEntryRecord(existingEntryRows[0], postingRows);
      } else {
        const clearRows = await tx
          .select()
          .from(ledgerJournalEntry)
          .where(and(eq(ledgerJournalEntry.paymentAttemptId, input.paymentAttemptId), eq(ledgerJournalEntry.entryType, "payment_cleared")))
          .limit(1);
        const clearEntry = clearRows[0];
        if (!clearEntry) {
          throw new ValidationError("Cannot pay out a payment that has not cleared.");
        }
        const clearPostingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, clearEntry.id));

        const reversalRows = await tx
          .select({ id: ledgerJournalEntry.id })
          .from(ledgerJournalEntry)
          .where(and(eq(ledgerJournalEntry.paymentAttemptId, input.paymentAttemptId), inArray(ledgerJournalEntry.entryType, ["refund", "reversal", "dispute_adjustment"])));
        if (reversalRows.length > 0) {
          throw new ValidationError("Cannot pay out a payment that has been refunded, reversed, or disputed.");
        }

        const creditorLeg = clearPostingRows.find((p) => p.accountType === "creditor_proceeds_payable");
        if (!creditorLeg) {
          throw new ValidationError("There are no creditor proceeds to pay out for this payment.");
        }

        const processorClearingRows = await tx
          .select()
          .from(ledgerAccount)
          .where(and(eq(ledgerAccount.accountType, "processor_clearing"), eq(ledgerAccount.agreementId, clearEntry.agreementId)))
          .limit(1);
        let processorClearingId: string;
        if (processorClearingRows[0]) {
          processorClearingId = processorClearingRows[0].id;
        } else {
          const [created] = await tx.insert(ledgerAccount).values({ accountType: "processor_clearing", agreementId: clearEntry.agreementId }).returning();
          if (!created) throw new ConfigurationError("ledger_account insert returned no row during atomic payout confirmation");
          processorClearingId = created.id;
        }

        const [entryRow] = await tx
          .insert(ledgerJournalEntry)
          .values({ entryType: "payout", agreementId: clearEntry.agreementId, paymentAttemptId: input.paymentAttemptId, currency: clearEntry.currency, reason: null })
          .returning();
        if (!entryRow) throw new ConfigurationError("ledger_journal_entry insert returned no row during atomic payout confirmation");
        const postingRows = await tx
          .insert(ledgerPosting)
          .values([
            { journalEntryId: entryRow.id, accountId: creditorLeg.accountId, accountType: "creditor_proceeds_payable", direction: "debit", amountMinorUnits: creditorLeg.amountMinorUnits },
            { journalEntryId: entryRow.id, accountId: processorClearingId, accountType: "processor_clearing", direction: "credit", amountMinorUnits: creditorLeg.amountMinorUnits },
          ])
          .returning();
        ledgerEntry = toEntryRecord(entryRow, postingRows);
      }
      if (this.hooks?.afterLedgerPost) await this.hooks.afterLedgerPost();

      // Step 3: mark payout_attempt confirmed.
      const confirmedAt = new Date();
      const [updatedAttemptRow] = await tx
        .update(payoutAttempt)
        .set({ status: "confirmed", confirmedAt, providerName: input.providerName, providerPayoutReference: input.providerPayoutReference })
        .where(and(eq(payoutAttempt.id, current.id), eq(payoutAttempt.status, "pending")))
        .returning();
      if (!updatedAttemptRow) {
        throw new ConfigurationError("payout_attempt confirm update affected no row — unexpected concurrent modification under an active row lock");
      }
      if (this.hooks?.afterAttemptMarked) await this.hooks.afterAttemptMarked();

      // Step 4: set payment_attempt.payoutCompletedAt — same transaction, same commit/rollback unit.
      const [updatedPaymentRow] = await tx
        .update(paymentAttempt)
        .set({ payoutCompletedAt: confirmedAt, updatedAt: new Date() })
        .where(eq(paymentAttempt.id, input.paymentAttemptId))
        .returning();
      if (!updatedPaymentRow) {
        throw new ConfigurationError("payment_attempt update returned no row during atomic payout confirmation");
      }

      return { outcome: "confirmed", record: toPayoutRecord(updatedAttemptRow), payoutCompletedAt: confirmedAt, ledgerEntry };
    });
  }
}
