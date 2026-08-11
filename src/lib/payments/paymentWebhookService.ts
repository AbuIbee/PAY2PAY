import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError } from "@/lib/errors";
import type { PaymentProvider } from "./paymentProvider";
import type { PaymentAttemptRepository, PaymentAttemptStatus } from "./paymentService";

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
}

const EVENT_TYPE_TO_STATUS: Record<string, PaymentAttemptStatus> = {
  "payment.succeeded": "succeeded",
  "payment.failed": "failed",
  "payment.refunded": "refunded",
  "payment.disputed": "disputed",
};

export type ReceiveWebhookResult = { status: "processed" | "duplicate" };

/**
 * Sprint 9 webhook handling: signature verification -> replay/duplicate-event protection ->
 * (asynchronous, relative to the originating provider call) processing -> state transition +
 * audit. A webhook event that does not map to a known transition (docs/PAYMENT_ARCHITECTURE.md
 * §12's "logged and routed to manual review rather than silently applied") is still recorded and
 * marked processed — it is simply a no-op state change, never an error, since redelivery of an
 * event this instance doesn't recognize must not fail the provider's retry loop.
 */
export class PaymentWebhookService {
  constructor(
    private readonly deps: {
      provider: PaymentProvider;
      events: PaymentWebhookEventRepository;
      payments: PaymentAttemptRepository;
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
    const newStatus = EVENT_TYPE_TO_STATUS[eventType];
    if (!newStatus) return;

    const providerPaymentId = typeof data.providerPaymentId === "string" ? data.providerPaymentId : null;
    if (!providerPaymentId) return;

    const payment = await this.deps.payments.findByProviderPaymentId(providerPaymentId);
    if (!payment) return;

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
  }
}
