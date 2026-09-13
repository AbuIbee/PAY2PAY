import "server-only";
import { classifyPaymentAttempts, reconstructPaidAndReversed } from "./balanceService";
import type { LedgerJournalEntryRecord } from "./ledgerService";

/**
 * R11 (INSTALLMENT AMOUNT-AWARENESS / PARTIAL-PAYMENT CORRECTNESS — ARCHITECT-APPROVED DESIGN):
 * the authoritative per-installment financial invariant. An installment is satisfied only when net
 * settled money (payment_cleared minus refund/reversal/dispute_adjustment) attributable to
 * payment_attempt rows whose own `installment_schedule_item_id` equals this installment is >= the
 * installment's own `amount_minor_units` — never derived from (or compared against) the installment's
 * own cached `status` column, which this entire module treats as a display/legacy field only.
 *
 * Deliberately reuses `reconstructPaidAndReversed` UNMODIFIED — the caller is responsible for
 * pre-filtering `entries` to exactly the ledger entries whose `paymentAttemptId` belongs to THIS
 * installment's own set of payment attempts (see `computeInstallmentSettlementWithinTx`, the
 * Postgres-backed counterpart that performs that join). This is the same "single source of truth for
 * ledger arithmetic, reused at a finer grain" precedent `computeRemainingBalanceMinorUnitsWithinTx`
 * (failedPaymentRetryCoordinator.ts) and `computeFreshEvidenceWithinTx` (agreementCompletionService.ts)
 * already establish for the agreement-level computation — never a second, independently-drifting copy
 * of the policy.
 *
 * `remainingMinorUnits` can in principle be negative for HISTORICAL data (an installment that was
 * overpaid before this invariant existed) — this module never clamps it, so a caller (e.g. the R11
 * historical-reconciliation sweep) can see and report the exact discrepancy rather than having it
 * silently floored to zero.
 */
export interface InstallmentSettlementSnapshot {
  installmentScheduleItemId: string;
  amountMinorUnits: number;
  settledMinorUnits: number;
  remainingMinorUnits: number;
  isSatisfied: boolean;
  /** Payment attempt ids whose own money currently counts toward `settledMinorUnits` (paid, not reversed) — R11 §9 reconciliation evidence. */
  contributingPaymentAttemptIds: string[];
}

export function computeInstallmentSettlement(
  installment: { id: string; amountMinorUnits: number },
  entries: LedgerJournalEntryRecord[],
): InstallmentSettlementSnapshot {
  const { amountPaidMinorUnits } = reconstructPaidAndReversed(entries);
  const contributingPaymentAttemptIds = [...classifyPaymentAttempts(entries).entries()]
    .filter(([, v]) => v.outcome === "paid")
    .map(([paymentAttemptId]) => paymentAttemptId);
  return {
    installmentScheduleItemId: installment.id,
    amountMinorUnits: installment.amountMinorUnits,
    settledMinorUnits: amountPaidMinorUnits,
    remainingMinorUnits: installment.amountMinorUnits - amountPaidMinorUnits,
    isSatisfied: amountPaidMinorUnits >= installment.amountMinorUnits,
    contributingPaymentAttemptIds,
  };
}
