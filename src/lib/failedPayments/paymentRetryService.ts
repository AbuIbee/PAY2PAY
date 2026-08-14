import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { logger } from "@/lib/logger";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentMethod } from "@/lib/payments/paymentService";
import { addBusinessDays } from "./businessDays";

export type PaymentRetryStatus = "scheduled" | "fired" | "canceled";

export interface PaymentRetryRecord {
  id: string;
  originalPaymentAttemptId: string;
  installmentScheduleItemId: string;
  agreementId: string;
  scheduledFor: Date;
  status: PaymentRetryStatus;
  resultingPaymentAttemptId: string | null;
  firedAt: Date | null;
  canceledAt: Date | null;
  canceledReason: string | null;
  createdAt: Date;
}

/** Real implementation: DrizzlePaymentRetryRepository. */
export interface PaymentRetryRepository {
  insert(input: {
    originalPaymentAttemptId: string;
    installmentScheduleItemId: string;
    agreementId: string;
    scheduledFor: Date;
  }): Promise<PaymentRetryRecord>;
  findByOriginalPaymentAttemptId(originalPaymentAttemptId: string): Promise<PaymentRetryRecord | null>;
  findByResultingPaymentAttemptId(resultingPaymentAttemptId: string): Promise<PaymentRetryRecord | null>;
  findScheduledForInstallment(installmentScheduleItemId: string): Promise<PaymentRetryRecord | null>;
  /** Cron-scan entry point — a periodic/administrative operation, not a per-request hot path (mirrors PaymentAttemptRepository.listAll's precedent). */
  findDueForFiring(now: Date): Promise<PaymentRetryRecord[]>;
  markFired(id: string, resultingPaymentAttemptId: string, firedAt: Date): Promise<PaymentRetryRecord>;
  markCanceled(id: string, canceledAt: Date, canceledReason: string): Promise<PaymentRetryRecord>;
}

/**
 * Whatever a payment method's own orchestration service (`AchPaymentService`/
 * `DebitCardPaymentService`) exposes for an ad-hoc payment — the retry's resulting charge is created
 * through this exact same gate any manual payment uses, never a separate/parallel path, matching
 * "never implement uncontrolled retries": a retry cannot bypass mandate/card-on-file/verification
 * checks that would otherwise apply.
 */
export interface RetryPaymentMethodInitiator {
  createManualPayment(input: {
    idempotencyKey: string;
    agreementId: string;
    payer: { profileKind: ProfileKind; profileId: string };
    recipient: { profileKind: ProfileKind; profileId: string };
    amountMinorUnits: number;
    currency: string;
    actingUserId: string;
    installmentScheduleItemId?: string;
  }): Promise<PaymentAttemptRecord>;
}

const DEFAULT_RETRY_DELAY_BUSINESS_DAYS = 3;

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): schedules and fires the
 * single automatic retry a failed installment payment gets (FR-FAIL-003), and cancels it if a
 * manual payment clears the installment first. "Never implement uncontrolled retries" /
 * "if retry fails, stop automatic retries" is enforced two ways at once: `scheduleRetryForFailedPayment`
 * refuses to create a second `payment_retry` row for the same original attempt (checked via
 * `findByOriginalPaymentAttemptId`) AND refuses to schedule a retry *for a payment that is itself
 * already a retry's own result* (checked via `findByResultingPaymentAttemptId`) — so even if a
 * retry's own charge later fails, nothing re-enters this method for it. The unique DB index on
 * `payment_retry.original_payment_attempt_id` (src/db/schema/paymentRetry.ts) is the same guarantee
 * enforced a second, race-safe way, mirroring Sprint 9/11's idempotency-key precedent.
 */
export class PaymentRetryService {
  private readonly delayBusinessDays: number;

  constructor(
    private readonly deps: {
      retries: PaymentRetryRepository;
      paymentAttempts: PaymentAttemptRepository;
      initiators: Record<PaymentMethod, RetryPaymentMethodInitiator>;
      profileOwners: ProfileOwnerReader;
      audit: AuditService;
      delayBusinessDays?: number;
    },
  ) {
    this.delayBusinessDays = deps.delayBusinessDays ?? DEFAULT_RETRY_DELAY_BUSINESS_DAYS;
  }

  async scheduleRetryForFailedPayment(payment: PaymentAttemptRecord, now: Date = new Date()): Promise<PaymentRetryRecord | null> {
    if (!payment.installmentScheduleItemId || !payment.agreementId) return null;

    const alreadyARetryResult = await this.deps.retries.findByResultingPaymentAttemptId(payment.id);
    if (alreadyARetryResult) return null; // this payment IS a retry's own charge — never re-retry it.

    const existing = await this.deps.retries.findByOriginalPaymentAttemptId(payment.id);
    if (existing) return existing; // idempotent replay of the same failure event.

    const scheduledFor = addBusinessDays(now, this.delayBusinessDays);
    const record = await this.deps.retries.insert({
      originalPaymentAttemptId: payment.id,
      installmentScheduleItemId: payment.installmentScheduleItemId,
      agreementId: payment.agreementId,
      scheduledFor,
    });

    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: payment.payerProfileKind,
      profileId: payment.payerProfileId,
      agreementId: payment.agreementId,
      action: "payment_retry_scheduled",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: scheduledFor.toISOString(),
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_retry",
      targetResourceId: record.id,
    });
    return record;
  }

  /** Requirement #7: "Cancel retry if manual payment succeeds." Idempotent no-op if nothing is scheduled. */
  async cancelForInstallment(installmentScheduleItemId: string, reason: string): Promise<void> {
    const scheduled = await this.deps.retries.findScheduledForInstallment(installmentScheduleItemId);
    if (!scheduled) return;
    const canceled = await this.deps.retries.markCanceled(scheduled.id, new Date(), reason);
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: null,
      profileId: null,
      agreementId: canceled.agreementId,
      action: "payment_retry_canceled",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: null,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_retry",
      targetResourceId: canceled.id,
    });
  }

  /**
   * Sprint 18B: the failed-payment detail card's "scheduled retry date" —
   * authorized the same way PaymentService.retrievePayment authorizes a
   * single payment (payer or recipient of the *original* attempt), since
   * this class has no party-role concept of its own beyond that.
   */
  async findForOriginalPayment(originalPaymentAttemptId: string, actingUserId: string): Promise<PaymentRetryRecord | null> {
    const original = await this.deps.paymentAttempts.findById(originalPaymentAttemptId);
    if (!original) return null;
    const [payerOwner, recipientOwner] = await Promise.all([
      this.deps.profileOwners.getOwnerUserId(original.payerProfileKind, original.payerProfileId),
      this.deps.profileOwners.getOwnerUserId(original.recipientProfileKind, original.recipientProfileId),
    ]);
    if (payerOwner !== actingUserId && recipientOwner !== actingUserId) return null;
    return this.deps.retries.findByOriginalPaymentAttemptId(originalPaymentAttemptId);
  }

  /**
   * The cron-triggered batch entry point (`POST /api/scheduler/retry-failed-payments`) — Vercel has
   * no persistent worker process, so "firing" a due retry only happens when something calls this,
   * not from a timer this class itself owns. Each retry's own creation failure (e.g. the mandate/card
   * was revoked or replaced since the original failure) is caught per-row and the retry is marked
   * canceled with the reason recorded — a firing failure never retries itself on the next cron tick.
   */
  async fireDueRetries(now: Date = new Date()): Promise<{ fired: number; canceled: number }> {
    const due = await this.deps.retries.findDueForFiring(now);
    let fired = 0;
    let canceled = 0;
    for (const retry of due) {
      try {
        const original = await this.deps.paymentAttempts.findById(retry.originalPaymentAttemptId);
        if (!original || !original.paymentMethod) {
          throw new Error("Original payment attempt not found or has no recorded payment method.");
        }
        const initiator = this.deps.initiators[original.paymentMethod];
        // System-initiated on the payer's behalf — every *Service.createManualPayment gate checks
        // `payerOwnerUserId === actingUserId` (PaymentService.reserveAttempt), so this must be the
        // payer profile's actual owning user id, never the profile id itself.
        const actingUserId = await this.deps.profileOwners.getOwnerUserId(original.payerProfileKind, original.payerProfileId);
        if (!actingUserId) {
          throw new Error("Could not resolve the payer profile's owning user.");
        }
        const resulting = await initiator.createManualPayment({
          idempotencyKey: `retry-${retry.id}`,
          agreementId: retry.agreementId,
          payer: { profileKind: original.payerProfileKind, profileId: original.payerProfileId },
          recipient: { profileKind: original.recipientProfileKind, profileId: original.recipientProfileId },
          amountMinorUnits: original.amountMinorUnits,
          currency: original.currency,
          actingUserId,
          // Keeps the retry's own resulting charge linked to the same installment — if this retry
          // itself later fails, the normal failure hook (mark past_due, notify) still applies to it,
          // while scheduleRetryForFailedPayment's own resultingPaymentAttemptId check prevents a
          // second payment_retry row from ever being created for it.
          installmentScheduleItemId: retry.installmentScheduleItemId,
        });
        await this.deps.retries.markFired(retry.id, resulting.id, now);
        fired += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown_retry_firing_error";
        logger.error("payment_retry_firing_failed", { paymentRetryId: retry.id, error: reason });
        await this.deps.retries.markCanceled(retry.id, now, `Firing failed: ${reason}`);
        canceled += 1;
      }
    }
    return { fired, canceled };
  }
}
