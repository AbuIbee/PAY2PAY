import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement, agreementVersion, installmentScheduleItem, ledgerAccount, ledgerJournalEntry, ledgerPosting, paymentAttempt } from "@/db/schema";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import { reconstructPaidAndReversed } from "@/lib/ledger/balanceService";
import {
  assertInstallmentBelongsToAgreementWithinTx,
  assertNoCompetingUnresolvedInstallmentAttemptWithinTx,
  computeInstallmentSettlementWithinTx,
} from "@/lib/ledger/installmentSettlementTx";
import type { LedgerJournalEntryRecord, LedgerPostingRecord } from "@/lib/ledger/ledgerService";
import type { AtomicManualPaymentPoster, PaymentAttemptRecord } from "./paymentService";

/**
 * R11 CORRECTION PASS A (Defect A3 — AGREEMENT/INSTALLMENT DEADLOCK CYCLE): the same kind of
 * production-safe, no-op-by-default test-only affordance as `InstallmentReservationTestHooks`
 * (`drizzleInstallmentAwarePaymentReserver.ts`) — lets a `*.postgres.test.ts` suite deterministically
 * pause this transaction the instant it genuinely holds the `agreement` row lock (this class's own
 * PRE-EXISTING, already-correct first lock — see `DrizzleAtomicManualPaymentPoster`'s own top-level
 * doc comment), long enough to prove a concurrently-racing provider reservation/retry dispatch on the
 * SAME agreement/installment queues behind it rather than crossing it out of order. Defaults to
 * `undefined`; every production call site (`new DrizzleAtomicManualPaymentPoster()`, no argument)
 * never sets it.
 */
export interface AtomicManualPaymentPosterTestHooks {
  /** Awaited immediately after the `agreement` row lock has been GRANTED — before the installment row (if any) is ever locked. */
  afterAgreementLock?: () => Promise<void>;
}

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
    lifecycleCheckedAt: row.lifecycleCheckedAt,
    financialRepairNextAttemptAt: row.financialRepairNextAttemptAt,
    settlementProposalId: row.settlementProposalId,
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
  /**
   * R11 CORRECTION PASS A: `db` is injectable (defaulting to the shared production singleton) so
   * `*.postgres.test.ts` concurrency suites can hand two instances of this class two genuinely
   * distinct PostgreSQL connections — mirrors `DrizzleAgreementRepository`'s identical precedent. Every
   * production call site (`new DrizzleAtomicManualPaymentPoster()`, no argument) is unaffected.
   */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: AtomicManualPaymentPosterTestHooks,
  ) {}

  async postManualPaymentAtomically(input: Parameters<AtomicManualPaymentPoster["postManualPaymentAtomically"]>[0]): Promise<PaymentAttemptRecord> {
    const db = this.db;
    return db.transaction(async (tx) => {
      // Row lock on the agreement itself — this is the serialization point. A second, concurrent
      // call for the SAME agreementId blocks here until this transaction commits or rolls back, then
      // re-reads the now-current state below, exactly like applySigningAtomically's identical
      // "re-read fresh inside the transaction" precedent for a double-signature race.
      //
      // R11 CORRECTION PASS A (Defect A3): this `agreement -> installment` order is the CANONICAL
      // order every other transaction that needs both locks now also follows (see
      // `DrizzleInstallmentAwarePaymentReserver`'s own top-level doc comment) — this class needed no
      // change to its own lock ORDER, only this test hook to prove the fixed system-wide order is now
      // deadlock-free under genuine concurrent contention.
      const agreementRows = await tx.select().from(agreement).where(eq(agreement.id, input.agreementId)).for("update");
      const agreementRow = agreementRows[0];
      if (!agreementRow) throw new ValidationError("Agreement not found.");
      if (!agreementRow.currentVersionId) throw new ValidationError("Agreement not found, or has no signed terms to compute a balance against yet.");
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();

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

      // R11 (INSTALLMENT AMOUNT-AWARENESS — PAYMENT INITIATION CEILING): when this manual payment
      // targets a specific installment, additionally lock that installment row and re-verify its own
      // remaining amount, in this SAME transaction — the agreement-level check above is preserved
      // unchanged; this is an additional, narrower gate.
      if (input.installmentScheduleItemId) {
        await tx.select({ id: installmentScheduleItem.id }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, input.installmentScheduleItemId)).for("update");
        // R11 CORRECTION PASS A (Defect A2): the target installment must genuinely belong to THIS
        // agreement's own CURRENT schedule — see `assertInstallmentBelongsToAgreementWithinTx`'s own
        // doc comment.
        await assertInstallmentBelongsToAgreementWithinTx(tx, input.installmentScheduleItemId, input.agreementId);
        // R11 TARGETED PROVIDER-RESERVATION CORRECTION: "at most one unresolved payment attempt per
        // installment" applies across BOTH rails — a manual payment must be rejected if a DIFFERENT,
        // still-unresolved PROVIDER-routed attempt already reserves this same installment, exactly
        // like the reverse case. Excludes this request's own idempotency key (see
        // `assertNoCompetingUnresolvedInstallmentAttemptWithinTx`'s own doc comment).
        await assertNoCompetingUnresolvedInstallmentAttemptWithinTx(tx, input.installmentScheduleItemId, input.idempotencyKey);
        const settlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);
        if (settlement && input.amountMinorUnits > settlement.remainingMinorUnits) {
          throw new ValidationError(
            `This payment of ${input.amountMinorUnits} minor units would exceed this installment's remaining amount of ${settlement.remainingMinorUnits} minor units. Overpayment against a single installment is not permitted.`,
          );
        }
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
          installmentScheduleItemId: input.installmentScheduleItemId ?? null,
          settlementProposalId: input.settlementProposalId ?? null,
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

