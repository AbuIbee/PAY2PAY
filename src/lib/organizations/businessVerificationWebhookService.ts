import "server-only";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { BusinessVerificationProvider } from "./businessVerificationProvider";
import type { BusinessVerificationWebhookEventRepository } from "./businessVerificationWebhookEventRepository";
import type { BusinessVerificationService } from "./businessVerificationService";

export type ReceiveBusinessVerificationWebhookResult = { status: "processed" | "duplicate" | "ignored" };

/**
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: a delivery is only EVER a "duplicate"
 * once it has actually completed processing. Before this value, a provider's retry of a delivery whose
 * first processing attempt failed (`processed_at` still null) was permanently, silently suppressed —
 * `claimEvent`'s own atomic claim is honored for this long before a LATER delivery may reclaim the
 * same row and retry it (recovering from a crashed in-flight attempt that never reached
 * `markProcessed`). Comfortably longer than this handler's own real work (a live re-fetch against the
 * provider plus a handful of local writes), short enough that a genuinely stuck delivery is retryable
 * again within the same operator shift.
 */
const EVENT_CLAIM_STALE_MS = 2 * 60 * 1000;

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 14/15: the Middesk webhook counterpart to
 * KycWebhookService (src/lib/kyc/kycWebhookService.ts) — identical signature-verification ->
 * duplicate-event-protection -> processing shape. Deliberately does NOT trust the webhook payload's
 * own status field as authoritative: on a `business.*` event it extracts only the opaque business id
 * and calls `BusinessVerificationService.applyVerificationResult`, which performs its own live
 * `retrieveVerificationStatus` re-fetch against Middesk before writing anything (Section 13's own
 * "a successful HTTP/API submission is NOT a successful Business verification" — a webhook delivery
 * alone is treated the same way: a trigger to re-check, never a self-reported decision taken at face
 * value). This also makes duplicate/replayed webhooks for the same business naturally idempotent at
 * the application layer (re-applying the same current status is a no-op), on top of this service's
 * own atomic claim-based dedupe below (Section P0-3).
 */
export class BusinessVerificationWebhookService {
  constructor(
    private readonly deps: {
      provider: BusinessVerificationProvider;
      events: BusinessVerificationWebhookEventRepository;
      verification: BusinessVerificationService;
    },
  ) {}

  async receiveWebhook(input: { rawBody: string; signatureHeader: string }): Promise<ReceiveBusinessVerificationWebhookResult> {
    const signatureValid = this.deps.provider.verifyWebhookSignature(input.rawBody, input.signatureHeader);
    if (!signatureValid) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }

    const parsed = this.deps.provider.parseWebhookEvent(input.rawBody);

    const claimed = await this.deps.events.claimEvent({
      provider: parsed.provider,
      providerEventId: parsed.providerEventId,
      eventType: parsed.eventType,
      signatureVerified: true,
      payload: parsed.data,
      staleClaimMs: EVENT_CLAIM_STALE_MS,
    });
    if (!claimed) {
      // Already successfully processed, or another delivery is actively/recently claiming it —
      // either way, safe to treat as a no-op duplicate (never a silent permanent suppression — see
      // this class's own doc comment).
      return { status: "duplicate" };
    }

    const applied = await this.applyEvent(parsed.eventType, parsed.data);
    await this.deps.events.markProcessed(claimed.id);
    return { status: applied ? "processed" : "ignored" };
  }

  private async applyEvent(eventType: string, data: Record<string, unknown>): Promise<boolean> {
    if (eventType !== "business.created" && eventType !== "business.updated") return false;

    const providerReference = typeof data.id === "string" ? data.id : null;
    if (!providerReference) return false;

    try {
      await this.deps.verification.applyVerificationResult(providerReference);
      return true;
    } catch (error) {
      // Unknown reference (a business this application never submitted, or a stale/foreign
      // delivery) must not fail the provider's retry loop — same no-op-not-error precedent as
      // KycWebhookService's identical "unmapped event" handling.
      if (error instanceof ValidationError) return false;
      throw error;
    }
  }
}
