import "server-only";

export interface BusinessVerificationWebhookEventRecord {
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
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: mirrors KycWebhookEventRepository
 * (src/lib/kyc/kycWebhookService.ts) in shape, but `claimEvent` replaces the prior separate
 * `findByProviderEvent`/`insert` pair — see `DrizzleBusinessVerificationWebhookEventRepository
 * .claimEvent`'s own doc comment for why: insertion alone used to mean "permanently treat every later
 * delivery as a duplicate," even one whose first processing attempt never completed.
 */
export interface BusinessVerificationWebhookEventRepository {
  /**
   * Atomically claims this (provider, providerEventId) event for processing. Returns `null` when this
   * is a genuine duplicate — the event was already successfully processed, or another delivery is
   * actively (or very recently) processing it right now. Otherwise returns the record to process:
   * either a brand-new event, or a RETRY of a previously failed/incomplete delivery whose
   * `processedAt` is still `null`. `staleClaimMs` bounds how long a claim is honored before a later
   * delivery may reclaim the same row (recovers from a crashed in-flight attempt that never called
   * `markProcessed`).
   */
  claimEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
    staleClaimMs: number;
  }): Promise<BusinessVerificationWebhookEventRecord | null>;
  markProcessed(id: string): Promise<void>;
}
