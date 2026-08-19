import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, ledgerAccount, ledgerJournalEntry, ledgerPosting, paymentAttempt } from "@/db/schema";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import { reconstructPaidAndReversed } from "@/lib/ledger/balanceService";
import type { LedgerJournalEntryRecord, LedgerPostingRecord } from "@/lib/ledger/ledgerService";
import type { AtomicManualPaymentPoster, PaymentAttemptRecord } from "./paymentService";

type LedgerEntryRow = typeof ledgerJournalEntry.$inferSelect;
type LedgerPostingRow = typeof ledgerPosting.$inferSelect;
type PaymentAttemptRow = typeof paymentAttempt.$inferSelect;

function toPaymentAttemptRecord(row: PaymentAttemptRow): PaymentAttemptRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    payerProfileKind: row.payerProfileKind,
    payerProfileId: row.payerProfileId,
    recipientProfileKind: row.recipientProfileKind,
    recipientProfileId: row.recipientProfileId,
    amountMinorUnits: row.amountMinorUnits,
    currency: row.currency,
    agreementId: row.agreementId,
    status: row.status,
    providerName: row.providerName,
    providerPaymentId: row.providerPaymentId,
    failureReason: row.failureReason,
    payoutCompletedAt: row.payoutCompletedAt,
    payoutInitiatedAt: row.payoutInitiatedAt,
    installmentScheduleItemId: row.installmentScheduleItemId,
    paymentMethod: row.paymentMethod,
    recordedByUserId: row.recordedByUserId,
    recipientConfirmedAt: row.recipientConfirmedAt,
    bankConnectionId: row.bankConnectionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

/**
 * PRSprint 20 (docs/prsprints/PRSPRINT_20_IDEMPOTENCY_CONCURRENCY_FINANCIAL_STATE_SAFETY.md): the
 * real implementation of `AtomicManualPaymentPoster` — see that interface's doc comment in
 * paymentService.ts for the concurrent-overpayment race this closes. Mirrors
 * `DrizzleSigningApplicationRepository`'s established "single, hand-written multi-table transaction,
 * writing directly against raw Drizzle table objects so every statement shares the same `tx`" pattern
 * exactly, for the identical reason: `DrizzlePaymentAttemptRepository`/`DrizzleLedgerAccountRepository`/
 * `DrizzleLedgerJournalEntryRepository` each open their own `getDb()` connection and are deliberately
 * left untouched (still correct, still used for every other read/write path).
 */
export class DrizzleAtomicManualPaymentPoster implements AtomicManualPaymentPoster {
  async postManualPaymentAtomically(input: Parameters<AtomicManualPaymentPoster["postManualPaymentAtomically"]>[0]): Promise<PaymentAttemptRecord> {
    const db = getDb();
    return db.transaction(async (tx) => {
      // Row lock on the agreement itself — this is the serialization point. A second, concurrent
      // call for the SAME agreementId blocks here until this transaction commits or rolls back, then
      // re-reads the now-current state below, exactly like applySigningAtomically's identical
      // "re-read fresh inside the transaction" precedent for a double-signature race.
      const agreementRows = await tx.select().from(agreement).where(eq(agreement.id, input.agreementId)).for("update");
      const agreementRow = agreementRows[0];
      if (!agreementRow) throw new ValidationError("Agreement not found.");
      if (!agreementRow.currentVersionId) throw new ValidationError("Agreement not found, or has no signed terms to compute a balance against yet.");

      const versionRows = await tx.select().from(agreementVersion).where(eq(agreementVersion.id, agreementRow.currentVersionId)).limit(1);
      const versionRow = versionRows[0];
      if (!versionRow) throw new ConfigurationError("agreement_version not found for agreement.current_version_id");
      const terms = versionRow.terms as AgreementTerms;

      // Re-verify the overpayment invariant with a fresh read, inside the lock — the caller
      // (PaymentService.recordManualOffPlatformPayment) already checked this against a read taken
      // *before* this transaction started; this is the authoritative check against a second request
      // racing past that earlier read concurrently.
      const entryRows = await tx.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.agreementId, input.agreementId));
      const entries: LedgerJournalEntryRecord[] = [];
      for (const entryRow of entryRows) {
        const postingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
        entries.push(toEntryRecord(entryRow, postingRows));
      }
      const { amountPaidMinorUnits } = reconstructPaidAndReversed(entries);
      const remainingBalanceMinorUnits = terms.currentPrincipalMinorUnits - amountPaidMinorUnits;
      if (input.amountMinorUnits > remainingBalanceMinorUnits) {
        throw new ValidationError(
          `This payment of ${input.amountMinorUnits} minor units would exceed the agreement's remaining balance of ${remainingBalanceMinorUnits} minor units. Overpayment is not permitted.`,
        );
      }

      const [paymentRow] = await tx
        .insert(paymentAttempt)
        .values({
          idempotencyKey: input.idempotencyKey,
          payerProfileKind: input.payerProfileKind,
          payerProfileId: input.payerProfileId,
          recipientProfileKind: input.recipientProfileKind,
          recipientProfileId: input.recipientProfileId,
          amountMinorUnits: input.amountMinorUnits,
          currency: input.currency,
          agreementId: input.agreementId,
          status: "succeeded",
          providerName: "manual",
          paymentMethod: "manual_off_platform",
          recordedByUserId: input.recordedByUserId,
        })
        .returning();
      if (!paymentRow) throw new ConfigurationError("payment_attempt insert returned no row during atomic manual payment posting");

      // findOrCreate for the two accounts payment_cleared needs, inlined against `tx` (mirrors
      // DrizzleLedgerAccountRepository.findOrCreate's upsert shape, but sharing this transaction —
      // no processor/platform fee on a manual payment, so only these two accounts are ever touched).
      // Kept inline (not a separate private method) so `tx`'s type is always inferred from this exact
      // `db.transaction` callback, rather than needing its own explicit, awkward type annotation.
      async function findOrCreateAccount(accountType: "processor_clearing" | "creditor_proceeds_payable"): Promise<string> {
        const existing = await tx
          .select()
          .from(ledgerAccount)
          .where(and(eq(ledgerAccount.accountType, accountType), eq(ledgerAccount.agreementId, input.agreementId)))
          .limit(1);
        if (existing[0]) return existing[0].id;
        const [created] = await tx.insert(ledgerAccount).values({ accountType, agreementId: input.agreementId }).returning();
        if (!created) throw new ConfigurationError("ledger_account insert returned no row during atomic manual payment posting");
        return created.id;
      }
      const processorClearingId = await findOrCreateAccount("processor_clearing");
      const creditorPayableId = await findOrCreateAccount("creditor_proceeds_payable");

      const [entryRow] = await tx
        .insert(ledgerJournalEntry)
        .values({ entryType: "payment_cleared", agreementId: input.agreementId, paymentAttemptId: paymentRow.id, currency: input.currency, reason: null })
        .returning();
      if (!entryRow) throw new ConfigurationError("ledger_journal_entry insert returned no row during atomic manual payment posting");
      await tx.insert(ledgerPosting).values([
        { journalEntryId: entryRow.id, accountId: processorClearingId, accountType: "processor_clearing", direction: "debit", amountMinorUnits: input.amountMinorUnits },
        { journalEntryId: entryRow.id, accountId: creditorPayableId, accountType: "creditor_proceeds_payable", direction: "credit", amountMinorUnits: input.amountMinorUnits },
      ]);

      return toPaymentAttemptRecord(paymentRow);
    });
  }
}

