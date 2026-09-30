import "server-only";
import { ValidationError } from "@/lib/errors";
import type { LedgerJournalEntryRecord, LedgerService } from "./ledgerService";

export type SettlementState = "unpaid" | "partially_paid" | "paid_in_full" | "overpaid" | "settled_in_full";

export interface AgreementBalance {
  agreementId: string;
  currency: string;
  originalPrincipalMinorUnits: number;
  amountPaidMinorUnits: number;
  reversedMinorUnits: number;
  effectiveForgivenMinorUnits: number;
  remainingBalanceMinorUnits: number;
  settlementState: SettlementState;
}

/**
 * Sprint 10's read-only window onto Sprint 5's immutable agreement terms — `currentPrincipalMinorUnits`
 * is read directly from `agreement_version.terms` (never duplicated into a ledger table), matching
 * this sprint's requirement #7 ("ledger activity must never rewrite agreement principal, terms").
 */
export interface AgreementTermsReader {
  getPrincipal(agreementId: string): Promise<{ principalMinorUnits: number; currency: string } | null>;
}

/**
 * Stage 4 (docs/remediation/ — settlement-balance defect remediation, corrected pass): the exact
 * binding consequence a settlement has on an agreement's remaining obligation. `BalanceService`
 * always establishes economically effective paid/reversed amount from the ledger FIRST, then applies
 * exactly one of these — never both, never neither when one legitimately applies:
 *
 * - `"none"` — no settlement exists, or the only settlement(s) are still `proposed`/`awaiting_payment`/
 *   `rejected` (SET-FINAL-04), or a `failure_consequence_applied` settlement whose own persisted
 *   consequence is `restore_original`/`prior_agreement_controls` (both already correct from the
 *   ordinary ledger-only calculation — see the reader's own implementation for the proof).
 * - `"forgiveness"` — either a `completed` settlement's own `forgivenAmountMinorUnits` (SET-FINAL-01),
 *   or a `failure_consequence_applied` settlement whose persisted `resolvedConsequence` is
 *   `forgive_permanently`, using its own `resolvedForgivenAmountMinorUnits` (SET-FINAL-02). Reduces
 *   `remainingBalanceMinorUnits`; never increases `amountPaidMinorUnits` (forgiveness is not a
 *   payment).
 * - `"restoredBalance"` — a `failure_consequence_applied` settlement whose persisted
 *   `resolvedConsequence` is `restore_stated`, using its own `resolvedRestoredBalanceMinorUnits`
 *   directly as the authoritative remaining obligation (SET-FINAL-03) — an override, not an
 *   arithmetic adjustment, since that stated figure need not decompose as principal-minus-anything.
 */
export type SettlementBalanceResolution =
  | { kind: "none" }
  | { kind: "forgiveness"; effectiveForgivenMinorUnits: number }
  | { kind: "restoredBalance"; restoredRemainingBalanceMinorUnits: number };

/**
 * The ONE authoritative source `BalanceService` consults for a settlement's binding effect on an
 * agreement's obligation — never a second, duplicated settlement-outcome figure. Real implementation
 * (`DrizzleSettlementBalanceReader`) reads directly from the same `settlement_proposal` table
 * `DrizzleSettlementRepository` already writes; see that class's own doc comment for the exact
 * precedence it applies among an agreement's settlement proposals.
 */
export interface SettlementBalanceReader {
  getSettlementBalanceResolution(agreementId: string): Promise<SettlementBalanceResolution>;
}

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) requirement #15: deterministic
 * balance reconstruction, entirely from Sprint 5's read-only principal plus `LedgerService`'s
 * journal history — never from a mutable cached balance field (none exists anywhere in this
 * codebase). Requirement #16 ("identical results regardless of read order") is structural here: see
 * `reconstruct`'s doc comment.
 */
export class BalanceService {
  constructor(
    private readonly deps: { ledger: LedgerService; terms: AgreementTermsReader; settlementBalance?: SettlementBalanceReader },
  ) {}

  async getAgreementBalance(agreementId: string): Promise<AgreementBalance> {
    const termsInfo = await this.deps.terms.getPrincipal(agreementId);
    if (!termsInfo) {
      throw new ValidationError("Agreement not found, or has no signed terms to compute a balance against yet.");
    }

    const entries = await this.deps.ledger.listEntriesForAgreement(agreementId);
    const { amountPaidMinorUnits, reversedMinorUnits } = this.reconstruct(entries);
    // Ledger-derived paid/reversed amounts are established FIRST, unconditionally — the settlement
    // resolution below only ever adjusts (forgiveness) or overrides (restoredBalance) the REMAINING
    // figure computed from them; `amountPaidMinorUnits` itself is never touched by any settlement
    // outcome (real cash paid only — see `SettlementBalanceResolution`'s own doc comment).
    const resolution: SettlementBalanceResolution = (await this.deps.settlementBalance?.getSettlementBalanceResolution(agreementId)) ?? { kind: "none" };

    let effectiveForgivenMinorUnits = 0;
    let remainingBalanceMinorUnits: number;
    let settlementState: SettlementState;

    if (resolution.kind === "restoredBalance") {
      // An authoritative override, not an arithmetic adjustment — SET-FINAL-03's own requirement.
      const restored = resolution.restoredRemainingBalanceMinorUnits;
      remainingBalanceMinorUnits = Math.max(0, restored);
      settlementState = restored > 0 ? (amountPaidMinorUnits <= 0 ? "unpaid" : "partially_paid") : "paid_in_full";
    } else {
      effectiveForgivenMinorUnits = resolution.kind === "forgiveness" ? resolution.effectiveForgivenMinorUnits : 0;
      // Stage 4: forgiveness is a distinct, non-negative reduction of the obligation, never a payment.
      // Only when forgiveness actually applies (effectiveForgivenMinorUnits > 0) is the remaining
      // balance floored at zero: an ordinary non-settlement agreement's remaining balance is left
      // exactly as before (still able to go negative to represent an overpayment — see
      // balanceService.test.ts's "'overpaid'" case), so this cannot regress any pre-existing,
      // non-settlement balance calculation.
      const rawRemainingBalanceMinorUnits = termsInfo.principalMinorUnits - amountPaidMinorUnits - effectiveForgivenMinorUnits;
      remainingBalanceMinorUnits = effectiveForgivenMinorUnits > 0 ? Math.max(0, rawRemainingBalanceMinorUnits) : rawRemainingBalanceMinorUnits;

      if (rawRemainingBalanceMinorUnits > 0) settlementState = amountPaidMinorUnits <= 0 ? "unpaid" : "partially_paid";
      else if (effectiveForgivenMinorUnits > 0) settlementState = "settled_in_full";
      else if (amountPaidMinorUnits === termsInfo.principalMinorUnits) settlementState = "paid_in_full";
      else settlementState = "overpaid";
    }

    return {
      agreementId,
      currency: termsInfo.currency,
      originalPrincipalMinorUnits: termsInfo.principalMinorUnits,
      amountPaidMinorUnits,
      reversedMinorUnits,
      effectiveForgivenMinorUnits,
      remainingBalanceMinorUnits,
      settlementState,
    };
  }

  private reconstruct(entries: LedgerJournalEntryRecord[]): { amountPaidMinorUnits: number; reversedMinorUnits: number } {
    return reconstructPaidAndReversed(entries);
  }
}

/**
 * PRSprint 20 (docs/prsprints/PRSPRINT_20_IDEMPOTENCY_CONCURRENCY_FINANCIAL_STATE_SAFETY.md):
 * extracted from BalanceService's private method (which now just delegates here, unchanged
 * behavior) and exported so `DrizzleAtomicManualPaymentPoster` can re-verify the exact same
 * "amount paid" total *inside* its locking transaction, without duplicating this business logic a
 * second time — a duplicated, hand-re-implemented version of this exact calculation is precisely the
 * kind of two-source-of-truth drift risk this codebase's "single source of truth" precedent
 * (docs/PAYMENT_ARCHITECTURE.md §14.1) exists to prevent.
 *
 * Groups entries by payment attempt, then sums each payment's gross-cleared amount into either
 * "paid" (cleared, never reversed) or "reversed" (cleared, then refunded/reversed/disputed —
 * whether the reversal used the pre-payout mirror shape or the post-payout clawback shape, the
 * debtor's obligation is treated as unsatisfied either way: docs/PAYMENT_ARCHITECTURE.md §7's
 * "reduce the agreement's recorded paid balance" applies to a late return regardless of whether
 * payout already occurred — only *who bears the clawback exposure* differs, not whether the
 * debtor's payment still counts). Each payment's contribution is computed independently of every
 * other payment and independently of iteration order, so summing in any order — or shuffling the
 * input array first — produces the identical total; see balanceService.test.ts.
 */
export function reconstructPaidAndReversed(entries: LedgerJournalEntryRecord[]): { amountPaidMinorUnits: number; reversedMinorUnits: number } {
  let amountPaidMinorUnits = 0;
  let reversedMinorUnits = 0;
  for (const { outcome, grossAmountMinorUnits } of classifyPaymentAttempts(entries).values()) {
    if (outcome === "reversed") reversedMinorUnits += grossAmountMinorUnits;
    else amountPaidMinorUnits += grossAmountMinorUnits;
  }
  return { amountPaidMinorUnits, reversedMinorUnits };
}

/**
 * R11 (installment amount-awareness): the per-payment classification `reconstructPaidAndReversed`
 * itself is built from — extracted, not duplicated, so a caller that needs to know WHICH specific
 * payment attempts contributed (e.g. `computeInstallmentSettlement`'s "contributing payment
 * attempts" evidence for a reconciliation exception) can get it from the exact same classification
 * `reconstructPaidAndReversed` already performs, rather than re-deriving it a second, independently-
 * drifting way. Same per-payment independence/order-independence guarantee as
 * `reconstructPaidAndReversed` — see that function's own doc comment.
 */
export function classifyPaymentAttempts(
  entries: LedgerJournalEntryRecord[],
): Map<string, { outcome: "paid" | "reversed"; grossAmountMinorUnits: number }> {
  const byPayment = new Map<string, LedgerJournalEntryRecord[]>();
  for (const entry of entries) {
    const list = byPayment.get(entry.paymentAttemptId) ?? [];
    list.push(entry);
    byPayment.set(entry.paymentAttemptId, list);
  }

  const result = new Map<string, { outcome: "paid" | "reversed"; grossAmountMinorUnits: number }>();
  for (const [paymentAttemptId, paymentEntries] of byPayment) {
    const clearEntry = paymentEntries.find((e) => e.entryType === "payment_cleared");
    if (!clearEntry) continue;
    const grossLeg = clearEntry.postings.find((p) => p.accountType === "processor_clearing" && p.direction === "debit");
    if (!grossLeg) continue;
    // Stage 4 (FI-01/FI-04 remediation): `LedgerService.correctRefund` posts `refund_correction`
    // ONLY to undo an existing `refund` entry (it targets `findByPaymentAndType(..., "refund")`
    // specifically — never `reversal`/`dispute_adjustment`) — see that method's own doc comment. So a
    // `refund` paired with its own `refund_correction` means the refund was economically undone: the
    // payment is once again "paid", not "reversed". `reversal`/`dispute_adjustment` are always full
    // reversals regardless of any `refund_correction` presence, since current ledger semantics never
    // link a correction to either of them. Neither the original `refund` row nor the
    // `refund_correction` row is erased or reinterpreted here — both remain in ledger history exactly
    // as posted; only this economic classification changes.
    const hasUncorrectedRefund = paymentEntries.some((e) => e.entryType === "refund") && !paymentEntries.some((e) => e.entryType === "refund_correction");
    const wasReversed = hasUncorrectedRefund || paymentEntries.some((e) => e.entryType === "reversal" || e.entryType === "dispute_adjustment");
    result.set(paymentAttemptId, { outcome: wasReversed ? "reversed" : "paid", grossAmountMinorUnits: grossLeg.amountMinorUnits });
  }
  return result;
}
