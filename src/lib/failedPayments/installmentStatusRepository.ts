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
  findDueDate(installmentScheduleItemId: string): Promise<string | null>;
  /** Used by RescheduleRequestService's approval path — never called by the failure/success hooks. */
  updateDueDate(installmentScheduleItemId: string, dueDate: string): Promise<void>;
}
