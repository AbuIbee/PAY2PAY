import "server-only";

/** Mirrors src/db/schema/enums.ts's feeAllocationEnum exactly (Sprint 5). */
export type FeeAllocation = "creditor_pays" | "debtor_pays" | "split_evenly";

/**
 * Sprint 12: read-only access to the signed agreement's fee-allocation term, needed by
 * cardFeeAllocation.ts's borrower-surcharge rule. Deliberately as narrow as
 * src/lib/ledger/balanceService.ts's `AgreementTermsReader` (one method, read-only) — this class has
 * no write path back to the agreement, so it cannot be the mechanism by which "no party may
 * unilaterally rewrite the contractual balance" is violated.
 */
export interface AgreementFeeAllocationReader {
  getFeeAllocation(agreementId: string): Promise<FeeAllocation | null>;
}
