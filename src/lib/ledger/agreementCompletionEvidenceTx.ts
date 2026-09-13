import "server-only";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { agreement, agreementVersion, installmentScheduleItem, ledgerJournalEntry, ledgerPosting } from "@/db/schema";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import { reconstructPaidAndReversed } from "./balanceService";
import { computeInstallmentSettlementWithinTx } from "./installmentSettlementTx";
import type { LedgerJournalEntryRecord } from "./ledgerService";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AgreementCompletionEvidence {
  settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid";
  amountPaidMinorUnits: number;
  installments: { status: string; dueDate: string }[];
  /** R11 §8: see `AgreementInstallmentSatisfactionChecker`'s own doc comment (agreementCompletionService.ts). */
  allNonWaivedInstallmentsSatisfied: boolean;
}

/**
 * R11 CORRECTION PASS A (Defect A4 — paid_in_full STALE-EVIDENCE RACE): extracted from
 * `AgreementCompletionService`'s own former private `computeFreshEvidenceWithinTx` — the SAME
 * tx-bound evidence computation `recomputeAfterSupersession` already used (fix #2 of that method's own
 * doc comment: lock the `agreement` row FIRST, then compute balance/installment evidence FRESH,
 * tx-bound, only AFTER that lock is held, so a concurrent payment/reversal/supersession that has
 * ALREADY COMMITTED by the time this runs is visible here, and a decision can never be based on
 * evidence a concurrently-settling event has already superseded). Now shared by BOTH
 * `recomputeAfterSupersession` (the backward/demotion direction) and
 * `DrizzleAtomicAgreementCompletionDecider.decideAndApply` (the forward/promotion direction, this
 * Pass's own new atomic counterpart to `checkAndAdvance`) — never a second, independently-drifting
 * copy of the same settlement-state/installment-satisfaction policy.
 *
 * Does NOT itself acquire the `agreement` row lock — every call site that needs the lock already
 * acquires its own `SELECT ... FOR UPDATE` on `agreement` earlier in the same transaction, exactly
 * like `computeInstallmentSettlementWithinTx`'s own identical contract for the installment lock.
 */
export async function computeAgreementCompletionEvidenceWithinTx(tx: Tx, agreementId: string): Promise<AgreementCompletionEvidence | null> {
  const agreementRows = await tx.select({ currentVersionId: agreement.currentVersionId }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
  const currentVersionId = agreementRows[0]?.currentVersionId;
  if (!currentVersionId) return null;

  const versionRows = await tx.select({ terms: agreementVersion.terms }).from(agreementVersion).where(eq(agreementVersion.id, currentVersionId)).limit(1);
  const versionRow = versionRows[0];
  if (!versionRow) return null;
  const principalMinorUnits = (versionRow.terms as AgreementTerms).currentPrincipalMinorUnits;

  const entryRows = await tx.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.agreementId, agreementId));
  const entries: LedgerJournalEntryRecord[] = [];
  for (const entryRow of entryRows) {
    const postingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
    entries.push({
      id: entryRow.id,
      entryType: entryRow.entryType,
      agreementId: entryRow.agreementId,
      paymentAttemptId: entryRow.paymentAttemptId,
      currency: entryRow.currency,
      reason: entryRow.reason,
      createdAt: entryRow.createdAt,
      postings: postingRows.map((p) => ({ id: p.id, accountId: p.accountId, accountType: p.accountType, direction: p.direction, amountMinorUnits: p.amountMinorUnits })),
    });
  }
  const { amountPaidMinorUnits } = reconstructPaidAndReversed(entries);

  let settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid";
  if (amountPaidMinorUnits <= 0) settlementState = "unpaid";
  else if (amountPaidMinorUnits < principalMinorUnits) settlementState = "partially_paid";
  else if (amountPaidMinorUnits === principalMinorUnits) settlementState = "paid_in_full";
  else settlementState = "overpaid";

  const installmentRows = await tx
    .select({ id: installmentScheduleItem.id, status: installmentScheduleItem.status, dueDate: installmentScheduleItem.dueDate })
    .from(installmentScheduleItem)
    .where(eq(installmentScheduleItem.agreementVersionId, currentVersionId));

  let allNonWaivedInstallmentsSatisfied = true;
  for (const item of installmentRows) {
    if (item.status === "waived") continue;
    const settlement = await computeInstallmentSettlementWithinTx(tx, item.id);
    if (!settlement || !settlement.isSatisfied) {
      allNonWaivedInstallmentsSatisfied = false;
      break;
    }
  }

  return {
    settlementState,
    amountPaidMinorUnits,
    installments: installmentRows.map((r) => ({ status: r.status, dueDate: r.dueDate })),
    allNonWaivedInstallmentsSatisfied,
  };
}
