import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError } from "@/lib/errors";
import type { LedgerService } from "@/lib/ledger/ledgerService";
import { logger } from "@/lib/logger";
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
  // Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) addition: a bank/network-initiated
  // return, distinct from a voluntary/dispute-resolved "refunded" — see paymentService.ts's
  // PaymentAttemptStatus doc comment.
  "payment.returned": "reversed",
};

/** Sprint 10: entry type each status-changing event maps to in the ledger, when that status change should also post a reversal. `payment.succeeded` and `payout.paid` are handled separately below (different LedgerService methods). */
const EVENT_TYPE_TO_REVERSAL_ENTRY: Record<string, "refund" | "reversal" | "dispute_adjustment"> = {
  "payment.refunded": "refund",
  "payment.returned": "reversal",
  "payment.disputed": "dispute_adjustment",
};

export type ReceiveWebhookResult = { status: "processed" | "duplicate" };

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

    const updated = await this.deps.payments.updateStatus(payment.id, newStatus, {});
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
