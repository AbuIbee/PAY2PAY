import "server-only";

export interface PlatformBillingWebhookEventRecord {
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
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: mirrors
 * BusinessVerificationWebhookEventRepository's identical `claimEvent` redesign — see that interface's
 * own doc comment for why insertion-only dedup (the prior `findByProviderEvent`/`insert` pair) is
 * unsafe: it permanently suppressed retry of an event whose first processing attempt failed.
 */
export interface PlatformBillingWebhookEventRepository {
  claimEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
    staleClaimMs: number;
  }): Promise<PlatformBillingWebhookEventRecord | null>;
  markProcessed(id: string): Promise<void>;
}
