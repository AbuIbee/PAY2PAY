import "server-only";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { VerificationService } from "@/lib/profiles/verificationService";
import type { KycKybProvider } from "./kycProvider";

export interface KycWebhookEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  signatureVerified: boolean;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
}

/** Sprint 9: separate from PaymentWebhookEventRepository — see src/db/schema/kyc.ts's doc comment. */
export interface KycWebhookEventRepository {
  findByProviderEvent(provider: string, providerEventId: string): Promise<KycWebhookEventRecord | null>;
  insert(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<KycWebhookEventRecord>;
  markProcessed(id: string): Promise<void>;
}

const EVENT_TYPE_TO_DECISION: Record<string, "verified" | "rejected"> = {
  "verification.approved": "verified",
  "verification.declined": "rejected",
};

export type ReceiveKycWebhookResult = { status: "processed" | "duplicate" };

/**
 * Sprint 9: the KYC/KYB webhook counterpart to PaymentWebhookService — same signature
 * verification -> replay/duplicate-event protection -> processing shape, applied here to
 * FULL_PENDING -> FULL_VERIFIED/FULL_REJECTED transitions instead of payment-status transitions.
 */
export class KycWebhookService {
  constructor(
    private readonly deps: {
      provider: KycKybProvider;
      events: KycWebhookEventRepository;
      verification: VerificationService;
    },
  ) {}

  async receiveWebhook(input: { rawBody: string; signatureHeader: string }): Promise<ReceiveKycWebhookResult> {
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
    const decision = EVENT_TYPE_TO_DECISION[eventType];
    if (!decision) return;

    const providerVerificationId = typeof data.providerVerificationId === "string" ? data.providerVerificationId : null;
    if (!providerVerificationId) return;

    try {
      await this.deps.verification.recordProviderVerificationDecision({
        providerRef: providerVerificationId,
        decision,
        reason: typeof data.reason === "string" ? data.reason : null,
      });
    } catch (error) {
      // No matching pending record (unknown ref, or already decided — e.g. a late/duplicate
      // decision webhook for a verification that was already resolved). A redelivered webhook must
      // not fail the provider's retry loop, so this is a no-op, not an error, exactly like
      // PaymentWebhookService's "unmapped event" handling.
      if (!(error instanceof ValidationError)) throw error;
    }
  }
}
