import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { ledgerJournalEntry, ledgerPosting } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  LedgerEntryType,
  LedgerJournalEntryRecord,
  LedgerJournalEntryRepository,
  LedgerPostingInput,
  LedgerPostingRecord,
} from "./ledgerService";

type EntryRow = typeof ledgerJournalEntry.$inferSelect;
type PostingRow = typeof ledgerPosting.$inferSelect;

function toPostingRecord(row: PostingRow): LedgerPostingRecord {
  return { id: row.id, accountId: row.accountId, accountType: row.accountType, direction: row.direction, amountMinorUnits: row.amountMinorUnits };
}

function toEntryRecord(row: EntryRow, postings: PostingRow[]): LedgerJournalEntryRecord {
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

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 7 — B28 test-quality correction): the
 * same kind of production-safe, no-op-by-default test-only affordance as `InstallmentLockTestHooks`
 * (see that interface's own doc comment). Lets a `*.postgres.test.ts` suite pause `insert` genuinely
 * INSIDE its own open transaction — after the row is inserted, before commit — long enough to
 * deterministically prove a second, independent connection racing the same unique
 * `(payment_attempt_id, entry_type)` key is genuinely blocked behind it. Defaults to `undefined`;
 * every production call site (`new DrizzleLedgerJournalEntryRepository()`, no second argument) never
 * sets it, so this can never run, or even be checked, outside a test.
 */
export interface LedgerJournalEntryInsertTestHooks {
  /** Awaited immediately after the journal entry row has been inserted, BEFORE the transaction commits — from this point until the hook resolves, this transaction is genuinely open and holding whatever the insert itself contends on. */
  afterEntryInsert?: () => Promise<void>;
}

export class DrizzleLedgerJournalEntryRepository implements LedgerJournalEntryRepository {
  /**
   * R07-style injectability: `db` defaults to the shared production singleton solely so
   * `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct connection.
   * Every production call site (`new DrizzleLedgerJournalEntryRepository()`, no argument) is unaffected.
   * `hooks` is the same kind of test-only affordance — see `LedgerJournalEntryInsertTestHooks`'s own doc comment.
   */
  constructor(
    private readonly injectedDb: Database = getDb(),
    private readonly hooks?: LedgerJournalEntryInsertTestHooks,
  ) {}

  async findByPaymentAndType(paymentAttemptId: string, entryType: LedgerEntryType): Promise<LedgerJournalEntryRecord | null> {
    const db = this.injectedDb;
    const rows = await db
      .select()
      .from(ledgerJournalEntry)
      .where(and(eq(ledgerJournalEntry.paymentAttemptId, paymentAttemptId), eq(ledgerJournalEntry.entryType, entryType)))
      .limit(1);
    const entryRow = rows[0];
    if (!entryRow) return null;
    const postings = await db.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
    return toEntryRecord(entryRow, postings);
  }

  async insert(input: {
    entryType: LedgerEntryType;
    agreementId: string;
    paymentAttemptId: string;
    currency: string;
    reason: string | null;
    postings: LedgerPostingInput[];
  }): Promise<LedgerJournalEntryRecord> {
    const db = this.injectedDb;
    return db.transaction(async (tx) => {
      const [entryRow] = await tx
        .insert(ledgerJournalEntry)
        .values({
          entryType: input.entryType,
          agreementId: input.agreementId,
          paymentAttemptId: input.paymentAttemptId,
          currency: input.currency,
          reason: input.reason,
        })
        .returning();
      if (!entryRow) throw new ConfigurationError("ledger_journal_entry insert returned no row");
      if (this.hooks?.afterEntryInsert) await this.hooks.afterEntryInsert();

      const postingRows =
        input.postings.length > 0
          ? await tx
              .insert(ledgerPosting)
              .values(
                input.postings.map((p) => ({
                  journalEntryId: entryRow.id,
                  accountId: p.accountId,
                  accountType: p.accountType,
                  direction: p.direction,
                  amountMinorUnits: p.amountMinorUnits,
                })),
              )
              .returning()
          : [];
      return toEntryRecord(entryRow, postingRows);
    });
  }

  async listForAgreement(agreementId: string): Promise<LedgerJournalEntryRecord[]> {
    const db = this.injectedDb;
    const entryRows = await db.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.agreementId, agreementId));
    return this.attachPostings(entryRows);
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<LedgerJournalEntryRecord[]> {
    const db = this.injectedDb;
    const entryRows = await db.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.paymentAttemptId, paymentAttemptId));
    return this.attachPostings(entryRows);
  }

  private async attachPostings(entryRows: EntryRow[]): Promise<LedgerJournalEntryRecord[]> {
    if (entryRows.length === 0) return [];
    const db = this.injectedDb;
    const results: LedgerJournalEntryRecord[] = [];
    for (const entryRow of entryRows) {
      const postings = await db.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
      results.push(toEntryRecord(entryRow, postings));
    }
    return results;
  }
}
