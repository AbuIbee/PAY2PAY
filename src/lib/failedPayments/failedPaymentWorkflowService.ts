import "server-only";
import type { NotificationEventType } from "@/lib/notify/eventTypes";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { PaymentAttemptRecord } from "@/lib/payments/paymentService";
import type { FailedPaymentWorkflow } from "@/lib/payments/paymentWebhookService";
import type { InstallmentStatusRepository } from "./installmentStatusRepository";
import type { PaymentRetryService } from "./paymentRetryService";

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): implements the
 * `FailedPaymentWorkflow` seam `PaymentWebhookService` calls (optionally) after a "failed" or
 * "succeeded" transition. Orchestrates this sprint's requirements #1–#7 in one place: mark
 * failure/notify/schedule retry, or mark paid/cancel any pending retry — steps #9–#10 (reschedule
 * request/approval) are a deliberately separate, borrower/creditor-initiated flow
 * (`RescheduleRequestService`), not triggered from here.
 */
export class FailedPaymentWorkflowService implements FailedPaymentWorkflow {
  constructor(
    private readonly deps: {
      installments: InstallmentStatusRepository;
      retries: PaymentRetryService;
      notifications: NotificationService;
      profileOwners: ProfileOwnerReader;
    },
  ) {}

  async handlePaymentFailed(payment: PaymentAttemptRecord, failureCategory: string | null): Promise<void> {
    if (!payment.installmentScheduleItemId) return;

    await this.deps.installments.markPastDue(payment.installmentScheduleItemId);
    await this.notifyBothParties(payment, "payment_failed", { failureCategory: failureCategory ?? "unknown" });
    await this.deps.retries.scheduleRetryForFailedPayment(payment);
  }

  async handlePaymentSucceeded(payment: PaymentAttemptRecord): Promise<void> {
    if (!payment.installmentScheduleItemId) return;

    await this.deps.installments.markPaid(payment.installmentScheduleItemId);
    // Requirement #7: a manual payment (or the retry itself) succeeding cancels any still-pending retry.
    await this.deps.retries.cancelForInstallment(payment.installmentScheduleItemId, "A payment for this installment succeeded.");
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
