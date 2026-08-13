import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError } from "@/lib/errors";
import type { LedgerService } from "@/lib/ledger/ledgerService";
import { logger } from "@/lib/logger";
import type { NotificationEventType } from "@/lib/notify/eventTypes";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { PaymentProvider } from "./paymentProvider";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentAttemptStatus } from "./paymentService";

export interface PaymentWebhookEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  signatureVerified: boolean;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
}

/**
 * Sprint 9: idempotency/replay-protection ledger for inbound payment-provider webhooks. Every
 * accepted (signature-valid) event gets exactly one row keyed by (provider, providerEventId) —
 * `insert` is expected to enforce that uniqueness at the storage layer, same optimistic-insert
 * pattern as PaymentAttemptRepository.insertPending.
 */
export interface PaymentWebhookEventRepository {
  findByProviderEvent(provider: string, providerEventId: string): Promise<PaymentWebhookEventRecord | null>;
  insert(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<PaymentWebhookEventRecord>;
  markProcessed(id: string): Promise<void>;
  /** Sprint 10: reconciliation's full-scan entry point (batch, not a per-request hot path). */
  listAll(): Promise<PaymentWebhookEventRecord[]>;
}

const EVENT_TYPE_TO_STATUS: Record<string, PaymentAttemptStatus> = {
  "payment.succeeded": "succeeded",
  "payment.failed": "failed",
  "payment.refunded": "refunded",
  "payment.disputed": "disputed",
  // A bank/network-initiated return (late ACH return), distinct from a voluntary/dispute-resolved
  // "refunded" — see paymentService.ts's PaymentAttemptStatus doc comment. Sprint 10 originally
  // mapped this to the mislabeled "reversed"; Sprint 11 corrected it to "returned" once
  // docs/PAYMENT_STATE_MACHINE.md's Returned/Reversed distinction was cross-checked (Returned =
  // ACH; Reversed = card chargeback, not applicable here).
  "payment.returned": "returned",
  // Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md): a card-network chargeback — the
  // "reversed" status Sprint 10 reserved and Sprint 11 confirmed is not an ACH concept (see
  // paymentService.ts's PaymentAttemptStatus doc comment). Cardholder-initiated via their issuer,
  // distinct from "payment.disputed" (an unauthorized-payment claim still under review) — a
  // chargeback event carries its own resolution, so it maps straight to the terminal-shaped
  // "reversed" status rather than routing through "disputed" first.
  "payment.reversed": "reversed",
};

/** Sprint 10: entry type each status-changing event maps to in the ledger, when that status change should also post a reversal. `payment.succeeded` and `payout.paid` are handled separately below (different LedgerService methods). */
const EVENT_TYPE_TO_REVERSAL_ENTRY: Record<string, "refund" | "reversal" | "dispute_adjustment"> = {
  "payment.refunded": "refund",
  "payment.returned": "reversal",
  "payment.disputed": "dispute_adjustment",
  // Sprint 12: reuses the same "reversal" ledger entry type ACH's late return uses —
  // docs/PAYMENT_ARCHITECTURE.md §10: "all three [return, chargeback, refund] converge on the same
  // ledger operation." LedgerService.reversePayment already auto-selects the correct pre/post-payout
  // shape; no ledger-side change was needed for this.
  "payment.reversed": "reversal",
};

export type ReceiveWebhookResult = { status: "processed" | "duplicate" };

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md) seam — deliberately just these
 * two methods, matching every other narrow, consumer-defined interface in this codebase (e.g.
 * `AgreementTermsReader`). Optional on `PaymentWebhookService` so Sprints 1–12's own tests, which
 * construct the service without it, are completely unaffected.
 */
export interface FailedPaymentWorkflow {
  handlePaymentFailed(payment: PaymentAttemptRecord, failureCategory: string | null): Promise<void>;
  handlePaymentSucceeded(payment: PaymentAttemptRecord): Promise<void>;
}

/**
 * Sprint 9 webhook handling: signature verification -> replay/duplicate-event protection ->
 * (asynchronous, relative to the originating provider call) processing -> state transition +
 * audit. A webhook event that does not map to a known transition (docs/PAYMENT_ARCHITECTURE.md
 * §12's "logged and routed to manual review rather than silently applied") is still recorded and
 * marked processed — it is simply a no-op state change, never an error, since redelivery of an
 * event this instance doesn't recognize must not fail the provider's retry loop.
 *
 * Sprint 10 addition: after each recognized status transition, also posts the corresponding
 * `LedgerService` entry (payment_cleared / refund / reversal / dispute_adjustment / payout). A
 * ledger-posting failure (most commonly: this payment has no `agreementId` — Sprint 9 made that
 * field optional for abstraction-testing purposes, but Sprint 10's ledger requires one) does not
 * fail the webhook or roll back the already-applied status update; it is caught, logged, and left
 * for `ReconciliationService`'s `internal_posting_failure` detector to surface as an explicit,
 * visible exception rather than a silent gap.
 */
export class PaymentWebhookService {
  constructor(
    private readonly deps: {
      provider: PaymentProvider;
      events: PaymentWebhookEventRepository;
      payments: PaymentAttemptRepository;
      ledger: LedgerService;
      audit: AuditService;
      /** Sprint 13: installment past_due/paid marking, notification, and retry scheduling — optional, see FailedPaymentWorkflow's doc comment. */
      failedPaymentWorkflow?: FailedPaymentWorkflow;
      /**
       * Sprint 17 (docs/sprints/SPRINT_17_Notifications.md) Product Owner review pass addition —
       * notifies both parties on a "succeeded" (`payment_cleared`) or "disputed" (`payment_disputed`)
       * transition, the two remaining payment-status events this sprint's own required event list
       * names that weren't yet wired to any real trigger (only `payment_failed`, via
       * `failedPaymentWorkflow`, existed at Sprint 17's initial implementation pass). Both optional —
       * every pre-Sprint-17 test constructing this service without them is unaffected — and, matching
       * `postLedgerEntry`/`runFailedPaymentWorkflow`'s identical "never fail the webhook" contract, a
       * notification failure here is caught and logged, never thrown.
       */
      notifications?: NotificationService;
      profileOwners?: ProfileOwnerReader;
    },
  ) {}

  async receiveWebhook(input: { rawBody: string; signatureHeader: string }): Promise<ReceiveWebhookResult> {
    const signatureValid = this.deps.provider.verifyWebhookSignature(input.rawBody, input.signatureHeader);
    if (!signatureValid) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }

    const parsed = this.deps.provider.parseWebhookEvent(input.rawBody);

    const existing = await this.deps.events.findByProviderEvent(parsed.provider, parsed.providerEventId);
    if (existing) {
      return { status: "duplicate" };
    }

    const eventRecord = await this.deps.events.insert({
      provider: parsed.provider,
      providerEventId: parsed.providerEventId,
      eventType: parsed.eventType,
      signatureVerified: true,
      payload: parsed.data,
    });

    await this.applyEvent(parsed.eventType, parsed.data);
    await this.deps.events.markProcessed(eventRecord.id);
    return { status: "processed" };
  }

  private async applyEvent(eventType: string, data: Record<string, unknown>): Promise<void> {
    const providerPaymentId = typeof data.providerPaymentId === "string" ? data.providerPaymentId : null;
    if (!providerPaymentId) return;
    const payment = await this.deps.payments.findByProviderPaymentId(providerPaymentId);
    if (!payment) return;

    if (eventType === "payout.paid") {
      await this.applyPayout(payment);
      return;
    }

    const newStatus = EVENT_TYPE_TO_STATUS[eventType];
    if (!newStatus) return;

    // Sprint 13 fix: this previously always passed `{}` here, silently discarding
    // `data.failureCategory` on every "payment.failed" webhook since Sprint 9 — no
    // non-sensitive failure category was ever actually stored, only ever asserted on `status` in
    // existing tests (see docs/SPRINT_CONTROL.md's "Sprint 13 implementation notes"). Per
    // docs/PAYMENT_ARCHITECTURE.md §6, the category here is already the non-sensitive, mapped
    // value the caller/processor-adapter is expected to send — the raw internal processor code
    // never reaches this layer, matching Sprint 9–11's "caller-supplied" webhook-payload precedent.
    const failureCategory =
      newStatus === "failed" && typeof data.failureCategory === "string" ? data.failureCategory : undefined;
    const updated = await this.deps.payments.updateStatus(
      payment.id,
      newStatus,
      failureCategory !== undefined ? { failureReason: failureCategory } : {},
    );
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: updated.payerProfileKind,
      profileId: updated.payerProfileId,
      agreementId: updated.agreementId,
      action: `payment_webhook_${eventType}`,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: payment.status,
      newValue: updated.status,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_attempt",
      targetResourceId: updated.id,
    });

    await this.postLedgerEntry(eventType, updated, data);
    await this.runFailedPaymentWorkflow(newStatus, updated, failureCategory ?? null);
    await this.notifyPaymentStatus(newStatus, updated);
  }

  /** Sprint 17 review-pass addition — see the constructor's `notifications`/`profileOwners` doc comment. */
  private async notifyPaymentStatus(status: PaymentAttemptStatus, payment: PaymentAttemptRecord): Promise<void> {
    if (!this.deps.notifications || !this.deps.profileOwners) return;
    const notificationType: NotificationEventType | null =
      status === "succeeded" ? "payment_cleared" : status === "disputed" ? "payment_disputed" : null;
    if (!notificationType) return;

    try {
      const [payerUserId, recipientUserId] = await Promise.all([
        this.deps.profileOwners.getOwnerUserId(payment.payerProfileKind, payment.payerProfileId),
        this.deps.profileOwners.getOwnerUserId(payment.recipientProfileKind, payment.recipientProfileId),
      ]);
      const recipients = [payerUserId, recipientUserId].filter((id): id is string => id !== null);
      await Promise.all(
        recipients.map((userId) =>
          this.deps.notifications!.notify({
            recipientUserId: userId,
            notificationType,
            relatedPaymentAttemptId: payment.id,
            relatedAgreementId: payment.agreementId,
            payload: { amountMinorUnits: payment.amountMinorUnits, currency: payment.currency },
            dedupeKey: `${notificationType}:${payment.id}:${userId}`,
          }),
        ),
      );
    } catch (error) {
      logger.error("payment_webhook_notification_failed", {
        paymentAttemptId: payment.id,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sprint 13: mirrors postLedgerEntry's own "never fail the webhook" contract — a workflow error
   * (installment update, notification, retry scheduling) is caught and logged, never thrown, so a
   * bug in this newer code path can't regress the webhook's own idempotent-processing guarantee for
   * Sprints 1–12. Only fires for installment-linked payments — an abstraction-level test payment
   * with no `installmentScheduleItemId` (Sprint 9's own tests) has nothing for this sprint's
   * retry/reschedule workflow to act on.
   */
  private async runFailedPaymentWorkflow(
    status: PaymentAttemptStatus,
    payment: PaymentAttemptRecord,
    failureCategory: string | null,
  ): Promise<void> {
    if (!this.deps.failedPaymentWorkflow || !payment.installmentScheduleItemId) return;
    try {
      if (status === "failed") {
        await this.deps.failedPaymentWorkflow.handlePaymentFailed(payment, failureCategory);
      } else if (status === "succeeded") {
        await this.deps.failedPaymentWorkflow.handlePaymentSucceeded(payment);
      }
    } catch (error) {
      logger.error("payment_webhook_failed_payment_workflow_failed", {
        paymentAttemptId: payment.id,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async postLedgerEntry(eventType: string, payment: PaymentAttemptRecord, data: Record<string, unknown>): Promise<void> {
    if (!payment.agreementId) {
      logger.error("payment_webhook_ledger_skip_no_agreement", { paymentAttemptId: payment.id, eventType });
      return;
    }
    try {
      if (eventType === "payment.succeeded") {
        const processorFeeMinorUnits = typeof data.processorFeeMinorUnits === "number" ? data.processorFeeMinorUnits : 0;
        const platformFeeMinorUnits = typeof data.platformFeeMinorUnits === "number" ? data.platformFeeMinorUnits : 0;
        await this.deps.ledger.postPaymentCleared({
          paymentAttemptId: payment.id,
          agreementId: payment.agreementId,
          currency: payment.currency,
          grossAmountMinorUnits: payment.amountMinorUnits,
          processorFeeMinorUnits,
          platformFeeMinorUnits,
        });
        return;
      }
      const reversalEntryType = EVENT_TYPE_TO_REVERSAL_ENTRY[eventType];
      if (reversalEntryType) {
        const reason = typeof data.reason === "string" ? data.reason : null;
        await this.deps.ledger.reversePayment({ paymentAttemptId: payment.id, entryType: reversalEntryType, reason });
      }
    } catch (error) {
      logger.error("payment_webhook_ledger_posting_failed", {
        paymentAttemptId: payment.id,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyPayout(payment: PaymentAttemptRecord): Promise<void> {
    if (!payment.agreementId) {
      logger.error("payment_webhook_ledger_skip_no_agreement", { paymentAttemptId: payment.id, eventType: "payout.paid" });
      return;
    }
    try {
      await this.deps.ledger.postPayout({ paymentAttemptId: payment.id });
      const updated = await this.deps.payments.markPayoutCompleted(payment.id, new Date());
      await this.deps.audit.record({
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: updated.payerProfileKind,
        profileId: updated.payerProfileId,
        agreementId: updated.agreementId,
        action: "payment_webhook_payout.paid",
        occurredAt: new Date().toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: updated.payoutCompletedAt,
        reason: null,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payment_attempt",
        targetResourceId: updated.id,
      });
    } catch (error) {
      logger.error("payment_webhook_ledger_posting_failed", {
        paymentAttemptId: payment.id,
        eventType: "payout.paid",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
