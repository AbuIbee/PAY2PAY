import "server-only";
import { ConfigurationError } from "@/lib/errors";
import type { NotificationEventType } from "@/lib/notify/eventTypes";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { PaymentAttemptRecord } from "@/lib/payments/paymentService";
import type { FailedPaymentWorkflow } from "@/lib/payments/paymentWebhookService";
import type { FailedPaymentRetryCoordinator } from "./failedPaymentRetryCoordinator";
import type { InstallmentStatusRepository } from "./installmentStatusRepository";
import type { PaymentRetryService } from "./paymentRetryService";

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): implements the
 * `FailedPaymentWorkflow` seam `PaymentWebhookService` calls (optionally) after a "failed" or
 * "succeeded" transition. Orchestrates this sprint's requirements #1–#7 in one place: mark
 * failure/notify/schedule retry, or mark paid/cancel any pending retry — steps #9–#10 (reschedule
 * request/approval) are a deliberately separate, borrower/creditor-initiated flow
 * (`RescheduleRequestService`), not triggered from here.
 *
 * PACKAGE B — FINAL NARROW CORRECTION (Codex blocker 7 residual race): `retryCoordinator` (optional,
 * mirrors `AuditEventRepository.appendAtomically`'s identical precedent) is the REAL, atomic path —
 * see `FailedPaymentRetryCoordinator`'s own doc comment for exactly how it closes the TOCTOU window
 * a plain "read installment status, then separately act" sequence leaves open. Every real production
 * wiring supplies it (`getFailedPaymentWorkflowService.ts`); the fallback below (no coordinator) is
 * for in-memory-fake-based unit tests that never race these two methods against each other for the
 * same installment.
 */
export class FailedPaymentWorkflowService implements FailedPaymentWorkflow {
  constructor(
    private readonly deps: {
      installments: InstallmentStatusRepository;
      retries: PaymentRetryService;
      notifications: NotificationService;
      profileOwners: ProfileOwnerReader;
      retryCoordinator?: FailedPaymentRetryCoordinator;
    },
  ) {}

  async handlePaymentFailed(payment: PaymentAttemptRecord, failureCategory: string | null): Promise<void> {
    if (!payment.installmentScheduleItemId) return;

    if (this.deps.retryCoordinator) {
      const result = await this.deps.retryCoordinator.coordinateFailure({
        installmentScheduleItemId: payment.installmentScheduleItemId,
        payment,
      });
      // Already settled by a later attempt under the SAME lock this transaction held — a stale
      // failure must produce no visible effect at all: no past_due write happened, no retry exists.
      if (result.outcome === "already_settled") return;
      await this.notifyBothParties(payment, "payment_failed", { failureCategory: failureCategory ?? "unknown" });
      return;
    }

    // Fallback (no atomic coordinator wired) — see this class's own doc comment.
    const currentStatus = await this.deps.installments.findStatus(payment.installmentScheduleItemId);
    if (currentStatus === "paid") return;
    await this.deps.installments.markPastDue(payment.installmentScheduleItemId);
    await this.notifyBothParties(payment, "payment_failed", { failureCategory: failureCategory ?? "unknown" });
    await this.deps.retries.scheduleRetryForFailedPayment(payment);
  }

  async handlePaymentSucceeded(payment: PaymentAttemptRecord): Promise<void> {
    if (!payment.installmentScheduleItemId) return;

    if (this.deps.retryCoordinator) {
      await this.deps.retryCoordinator.coordinateSuccess({ installmentScheduleItemId: payment.installmentScheduleItemId });
      return;
    }

    // Fallback (no atomic coordinator wired) — see this class's own doc comment.
    await this.deps.installments.markPaid(payment.installmentScheduleItemId);
    // Requirement #7: a manual payment (or the retry itself) succeeding cancels any still-pending retry.
    await this.deps.retries.cancelForInstallment(payment.installmentScheduleItemId, "A payment for this installment succeeded.");
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 6 targeted correction — exact-once supersession compensation, per
   * ChatGPT's own required Case C fix): `PaymentWebhookService` calls this from a
   * `payment.disputed`/`refunded`/`returned`/`reversed` event's OWN processing, once that event's own
   * transition durably proves it just superseded a "succeeded" payment — see
   * `PaymentWebhookService.runSupersessionCompensationRequired`'s own doc comment. Reopens an
   * installment this payment's earlier success had marked "paid" — never creates a fresh
   * `payment_retry` (approved architecture: the installment becomes payable again, but a subsequent
   * charge must come through the normal, explicitly authorized payment flow, never an automatic
   * recharge after a dispute/refund/return/reversal).
   *
   * FAIL CLOSED — no non-atomic fallback (unlike `handlePaymentFailed`/`handlePaymentSucceeded` above,
   * whose existing, pre-this-correction fallback behavior is deliberately left unchanged): this
   * effect is financial-correctness critical and its ENTIRE safety property is the durable,
   * transactional `(providerEventId, action)` marker `FailedPaymentRetryCoordinator.coordinateSupersession`
   * writes atomically with the installment mutation (see that method's own doc comment for exactly
   * why `installment.status` alone is unsafe — a real, traced Case C corruption). A "no coordinator"
   * fallback here would have to mutate the installment without that marker, silently reintroducing
   * the exact defect this correction exists to close. If `retryCoordinator` is not wired, this throws
   * — every real production wiring (`getFailedPaymentWorkflowService.ts`) always supplies it, so this
   * is unreachable in production; a test that needs to exercise `handlePaymentSuperseded` must wire
   * the real coordinator, exactly as the new Postgres regression tests do.
   */
  async handlePaymentSuperseded(payment: PaymentAttemptRecord, providerEventId: string): Promise<void> {
    if (!payment.installmentScheduleItemId) return;
    if (!this.deps.retryCoordinator) {
      throw new ConfigurationError(
        "handlePaymentSuperseded requires the atomic FailedPaymentRetryCoordinator — no non-atomic fallback is permitted for supersession compensation.",
      );
    }
    await this.deps.retryCoordinator.coordinateSupersession({
      installmentScheduleItemId: payment.installmentScheduleItemId,
      payment,
      providerEventId,
    });
  }

  private async notifyBothParties(
    payment: PaymentAttemptRecord,
    notificationType: NotificationEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const [payerUserId, recipientUserId] = await Promise.all([
      this.deps.profileOwners.getOwnerUserId(payment.payerProfileKind, payment.payerProfileId),
      this.deps.profileOwners.getOwnerUserId(payment.recipientProfileKind, payment.recipientProfileId),
    ]);
    const recipients = [payerUserId, recipientUserId].filter((id): id is string => id !== null);
    await Promise.all(
      recipients.map((recipientUserId) =>
        this.deps.notifications.notify({
          recipientUserId,
          notificationType,
          relatedPaymentAttemptId: payment.id,
          relatedAgreementId: payment.agreementId,
          payload,
          // Non-sensitive only — never a raw processor code, per docs/PAYMENT_ARCHITECTURE.md §6.
          // Idempotent per (payment, recipient, type) — safe if this webhook-driven handler is ever
          // invoked twice for the same payment_attempt.
          dedupeKey: `${notificationType}:${payment.id}:${recipientUserId}`,
        }),
      ),
    );
  }
}
