import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
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

export class DrizzleLedgerJournalEntryRepository implements LedgerJournalEntryRepository {
  async findByPaymentAndType(paymentAttemptId: string, entryType: LedgerEntryType): Promise<LedgerJournalEntryRecord | null> {
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
    const entryRows = await db.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.agreementId, agreementId));
    return this.attachPostings(entryRows);
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<LedgerJournalEntryRecord[]> {
    const db = getDb();
    const entryRows = await db.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.paymentAttemptId, paymentAttemptId));
    return this.attachPostings(entryRows);
  }

  private async attachPostings(entryRows: EntryRow[]): Promise<LedgerJournalEntryRecord[]> {
    if (entryRows.length === 0) return [];
    const db = getDb();
    const results: LedgerJournalEntryRecord[] = [];
    for (const entryRow of entryRows) {
      const postings = await db.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
      results.push(toEntryRecord(entryRow, postings));
    }
    return results;
  }
}
