import "server-only";
import type { FeeAllocation } from "./agreementFeeAllocationReader";

/**
 * Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md) sandbox processor-fee simulation.
 * No live processor is integrated (open decision #3, unchanged since Sprint 9) — these are
 * illustrative, fixed sandbox rates, not a processor-derived fee schedule, matching Sprint 10's own
 * documented "processor fee amounts are caller-supplied, not processor-derived" known limitation.
 * ACH is modeled at zero fee (master spec §6: "ACH should be presented as the standard low-cost
 * payment method" — this project's existing ACH code has in fact never simulated any processor fee
 * at all, per Sprint 9/10/11's ledger tests, which is the baseline this sprint's "more expensive"
 * comparison is made against). Debit card uses a flat illustrative rate (2.9% + $0.30), a realistic
 * approximation of a real card-not-present processor rate, clearly not a contracted number.
 */
export const SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS = 0;
const SANDBOX_CARD_PROCESSOR_FEE_RATE = 0.029;
const SANDBOX_CARD_PROCESSOR_FEE_FIXED_MINOR_UNITS = 30;

/** Deterministic, integer-minor-units-only (FR-MONEY-001) — no floating-point money math beyond this single rounding step. */
export function computeCardProcessorFeeMinorUnits(amountMinorUnits: number): number {
  return Math.round(amountMinorUnits * SANDBOX_CARD_PROCESSOR_FEE_RATE) + SANDBOX_CARD_PROCESSOR_FEE_FIXED_MINOR_UNITS;
}

/**
 * Master spec §6 / this sprint's "Fee rule": "If borrower switches from ACH to a more expensive
 * debit-card method, the borrower pays the incremental processor cost unless the signed agreement
 * or mutual amendment states otherwise. Do not silently reduce creditor net proceeds."
 *
 * "unless the signed agreement... states otherwise" resolves against the agreement's own,
 * already-existing `feeAllocation` term (Sprint 5) rather than a new field — no Sprint 14/15
 * amendment mechanism exists yet to add a separate override:
 * - `"creditor_pays"`: the creditor has already contractually agreed to bear all processing costs
 *   regardless of method — this literally *is* "the agreement... states otherwise," so the borrower
 *   is surcharged nothing and the creditor absorbs the full card fee.
 * - `"debtor_pays"` / `"split_evenly"`: neither term specifically addresses a *method-switch*
 *   increment, so the master spec's explicit default applies — the borrower is surcharged exactly
 *   the incremental cost (card fee minus the ACH baseline), never more, never the whole card fee.
 *
 * Charging this surcharge on top of the scheduled amount (rather than reducing what reaches the
 * ledger's creditor-net calculation) is the mechanism behind "must not silently reduce creditor net
 * proceeds": the creditor's gross entering `LedgerService.postPaymentCleared` already includes the
 * surcharge, so subtracting the same processor fee from that larger gross still nets the creditor
 * the full amount they'd have received via ACH.
 */
export function computeBorrowerSurchargeMinorUnits(input: {
  feeAllocation: FeeAllocation;
  achEquivalentFeeMinorUnits: number;
  cardProcessorFeeMinorUnits: number;
}): number {
  if (input.feeAllocation === "creditor_pays") return 0;
  return Math.max(0, input.cardProcessorFeeMinorUnits - input.achEquivalentFeeMinorUnits);
}
