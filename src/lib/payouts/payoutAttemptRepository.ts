export type PayoutAttemptStatus = "pending" | "confirmed" | "failed" | "returned";

export interface PayoutAttemptRecord {
  id: string;
  paymentAttemptId: string;
  agreementId: string;
  status: PayoutAttemptStatus;
  createdAt: Date;
  confirmedAt: Date | null;
  providerName: string | null;
  providerPayoutReference: string | null;
  failedAt: Date | null;
  failureReason: string | null;
  returnedAt: Date | null;
  returnReason: string | null;
}

/**
 * PAID2YOU — B0-D PHASE 3A (eliminate fictional payouts). See `src/db/schema/payoutAttempt.ts`'s own
 * doc comment for the full lifecycle this repository's rows durably track. Real implementation:
 * `DrizzlePayoutAttemptRepository`.
 */
export interface PayoutAttemptRepository {
  /** Idempotent: if a row already exists for this `paymentAttemptId`, returns it unchanged rather than inserting a second one — see `PayoutService.recordPayoutOwed`'s own doc comment. */
  insert(input: { paymentAttemptId: string; agreementId: string }): Promise<PayoutAttemptRecord>;
  findByPaymentAttemptId(paymentAttemptId: string): Promise<PayoutAttemptRecord | null>;
  /** `pending` -> `confirmed`, keyed by the row's own id to avoid a second unscoped lookup after the caller already resolved it. */
  markConfirmed(id: string, input: { confirmedAt: Date; providerName: string; providerPayoutReference: string }): Promise<PayoutAttemptRecord>;
  /** `pending` -> `failed`. Never touches any ledger row — the creditor's own liability is left exactly as `payment_cleared` posted it. */
  markFailed(id: string, input: { failedAt: Date; failureReason: string }): Promise<PayoutAttemptRecord>;
  /** `confirmed` -> `returned`. */
  markReturned(id: string, input: { returnedAt: Date; returnReason: string }): Promise<PayoutAttemptRecord>;
}
