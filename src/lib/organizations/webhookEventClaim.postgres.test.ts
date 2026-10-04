import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DrizzleBusinessVerificationWebhookEventRepository } from "./drizzleBusinessVerificationWebhookEventRepository";
import { DrizzlePlatformBillingWebhookEventRepository } from "./drizzlePlatformBillingWebhookEventRepository";

/**
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: proves the REAL atomic
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` claim mechanism — both
 * `DrizzleBusinessVerificationWebhookEventRepository.claimEvent` and
 * `DrizzlePlatformBillingWebhookEventRepository.claimEvent` — against genuine concurrent Postgres
 * connections (never merely the in-memory test-double approximation
 * `businessVerificationWebhookService.test.ts`/`platformBillingWebhookService.test.ts` already use for
 * their own, service-level proofs). This is the one place the actual row-level locking guarantee is
 * exercised for real.
 */
describe("P0-3: webhook-event claimEvent atomicity under REAL concurrent Postgres connections", () => {
  it("DrizzleBusinessVerificationWebhookEventRepository: two genuinely concurrent claims for a BRAND-NEW event — exactly one wins", async () => {
    const repo = new DrizzleBusinessVerificationWebhookEventRepository();
    const providerEventId = `evt_concurrent_${randomUUID()}`;
    const claimInput = { provider: "middesk", providerEventId, eventType: "business.updated", signatureVerified: true, payload: { id: "biz_1" }, staleClaimMs: 2 * 60 * 1000 };

    const [a, b] = await Promise.all([repo.claimEvent(claimInput), repo.claimEvent(claimInput)]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("DrizzleBusinessVerificationWebhookEventRepository: a claimed-but-unprocessed row cannot be reclaimed within the stale window, but CAN be reclaimed once stale", async () => {
    const repo = new DrizzleBusinessVerificationWebhookEventRepository();
    const providerEventId = `evt_stale_${randomUUID()}`;
    const first = await repo.claimEvent({ provider: "middesk", providerEventId, eventType: "business.updated", signatureVerified: true, payload: { id: "biz_1" }, staleClaimMs: 2 * 60 * 1000 });
    expect(first).not.toBeNull();

    // Within the stale window: a second claim attempt is refused (another delivery is "actively" processing it).
    const withinWindow = await repo.claimEvent({ provider: "middesk", providerEventId, eventType: "business.updated", signatureVerified: true, payload: { id: "biz_1" }, staleClaimMs: 2 * 60 * 1000 });
    expect(withinWindow).toBeNull();

    // Once "stale" (a zero-length window makes the existing claim immediately stale), a retry succeeds.
    const afterStale = await repo.claimEvent({ provider: "middesk", providerEventId, eventType: "business.updated", signatureVerified: true, payload: { id: "biz_1" }, staleClaimMs: 0 });
    expect(afterStale).not.toBeNull();
  });

  it("DrizzleBusinessVerificationWebhookEventRepository: once markProcessed, no later claim ever succeeds again — a genuine permanent duplicate", async () => {
    const repo = new DrizzleBusinessVerificationWebhookEventRepository();
    const providerEventId = `evt_processed_${randomUUID()}`;
    const claimed = await repo.claimEvent({ provider: "middesk", providerEventId, eventType: "business.updated", signatureVerified: true, payload: { id: "biz_1" }, staleClaimMs: 2 * 60 * 1000 });
    expect(claimed).not.toBeNull();
    await repo.markProcessed(claimed!.id);

    const afterProcessed = await repo.claimEvent({ provider: "middesk", providerEventId, eventType: "business.updated", signatureVerified: true, payload: { id: "biz_1" }, staleClaimMs: 0 });
    expect(afterProcessed).toBeNull();
  });

  it("DrizzlePlatformBillingWebhookEventRepository: two genuinely concurrent claims for a BRAND-NEW event — exactly one wins", async () => {
    const repo = new DrizzlePlatformBillingWebhookEventRepository();
    const providerEventId = `evt_concurrent_${randomUUID()}`;
    const claimInput = { provider: "stripe", providerEventId, eventType: "invoice.paid", signatureVerified: true, payload: { id: "in_1" }, staleClaimMs: 2 * 60 * 1000 };

    const [a, b] = await Promise.all([repo.claimEvent(claimInput), repo.claimEvent(claimInput)]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("DrizzlePlatformBillingWebhookEventRepository: once markProcessed, no later claim ever succeeds again", async () => {
    const repo = new DrizzlePlatformBillingWebhookEventRepository();
    const providerEventId = `evt_processed_${randomUUID()}`;
    const claimed = await repo.claimEvent({ provider: "stripe", providerEventId, eventType: "invoice.paid", signatureVerified: true, payload: { id: "in_1" }, staleClaimMs: 2 * 60 * 1000 });
    expect(claimed).not.toBeNull();
    await repo.markProcessed(claimed!.id);

    const afterProcessed = await repo.claimEvent({ provider: "stripe", providerEventId, eventType: "invoice.paid", signatureVerified: true, payload: { id: "in_1" }, staleClaimMs: 0 });
    expect(afterProcessed).toBeNull();
  });
});
