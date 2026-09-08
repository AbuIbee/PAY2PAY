import "server-only";

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): before this sprint, nothing
 * in this codebase ever wrote to `installment_schedule_item.status` after Sprint 5 created it at
 * `"scheduled"` — a real, pre-existing gap this sprint closes, since the retry/reschedule workflow
 * needs to know an installment's current status and this sprint's "Preserve original installment
 * record" requirement is precisely about this row, not the payment_attempt rows referencing it.
 * Kept as its own narrow interface (mirrors `AgreementTermsReader`/`AgreementFeeAllocationReader`)
 * rather than extending `InstallmentScheduleItemRepository` (`src/lib/agreements/agreementService.ts`),
 * which only ever writes a whole version's schedule at once (`replaceForVersion`) — a single-item
 * status transition is a different, narrower write than that interface was built for.
 */
export interface InstallmentStatusRepository {
  markPastDue(installmentScheduleItemId: string): Promise<void>;
  markPaid(installmentScheduleItemId: string): Promise<void>;
  /**
   * PAID2YOU — PACKAGE B (Stage 6 blocking substage — post-success supersession compensation): the
   * ONLY caller is the no-coordinator fallback path of `FailedPaymentWorkflowService.handlePaymentSuperseded`
   * (production always wires the real `FailedPaymentRetryCoordinator.coordinateSupersession`, which
   * writes this directly, atomically, under its own installment row lock — see that method's own doc
   * comment). Reopens a "paid" installment back to "scheduled" — used when a payment.disputed/
   * refunded/returned/reversed event proves the earlier success that marked it "paid" has been
   * financially superseded, and the installment's own due date has not yet passed.
   */
  markScheduled(installmentScheduleItemId: string): Promise<void>;
  findDueDate(installmentScheduleItemId: string): Promise<string | null>;
  /** Used by RescheduleRequestService's approval path — never called by the failure/success hooks. */
  updateDueDate(installmentScheduleItemId: string, dueDate: string): Promise<void>;
  /**
   * R09 corrective pass (Codex blocker 7 — failed-payment-workflow replay safety): lets
   * `FailedPaymentWorkflowService.handlePaymentFailed` revalidate current installment state before
   * acting — a stale/out-of-order replay of an EARLIER failed attempt (resumed/retried after a LATER
   * attempt for the same installment already succeeded) must see the real current status, not act
   * blindly. `markPastDue`'s own atomic `AND status <> 'paid'` guard is the authoritative backstop;
   * this read lets the retry-scheduling side (which has no such atomic guard of its own) skip
   * entirely rather than create a stale retry for an installment that has already settled.
   */
  findStatus(installmentScheduleItemId: string): Promise<string | null>;
}
