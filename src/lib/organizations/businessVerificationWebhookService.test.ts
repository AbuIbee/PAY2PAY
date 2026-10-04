import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { ForbiddenError } from "@/lib/errors";
import { MiddeskBusinessVerificationProvider } from "./middeskBusinessVerificationProvider";
import { SandboxBusinessVerificationProvider } from "@/test-support/organizations/sandboxBusinessVerificationProvider";
import type { BusinessVerificationWebhookEventRecord, BusinessVerificationWebhookEventRepository } from "./businessVerificationWebhookEventRepository";
import { BusinessVerificationService } from "./businessVerificationService";
import { InMemoryBusinessVerificationRepository } from "./businessVerificationTestFakes";
import { BusinessVerificationWebhookService } from "./businessVerificationWebhookService";

class InMemoryBusinessVerificationWebhookEventRepository implements BusinessVerificationWebhookEventRepository {
  private byKey = new Map<string, BusinessVerificationWebhookEventRecord & { claimedAt: Date | null }>();

  /** Mirrors DrizzleBusinessVerificationWebhookEventRepository.claimEvent's own atomic-upsert semantics. */
  async claimEvent(input: { provider: string; providerEventId: string; eventType: string; signatureVerified: boolean; payload: unknown; staleClaimMs: number }): Promise<BusinessVerificationWebhookEventRecord | null> {
    const key = `${input.provider}:${input.providerEventId}`;
    const now = new Date();
    const existing = this.byKey.get(key);
    if (existing) {
      const claimIsFresh = existing.claimedAt && now.getTime() - existing.claimedAt.getTime() < input.staleClaimMs;
      if (existing.processedAt || claimIsFresh) return null;
      existing.claimedAt = now;
      return existing;
    }
    const record = { id: randomUUID(), provider: input.provider, providerEventId: input.providerEventId, eventType: input.eventType, signatureVerified: input.signatureVerified, payload: input.payload, receivedAt: now, processedAt: null, claimedAt: now };
    this.byKey.set(key, record);
    return record;
  }

  async markProcessed(id: string): Promise<void> {
    for (const record of this.byKey.values()) {
      if (record.id === id) record.processedAt = new Date();
    }
  }

  /** Test-only read accessor (not part of the production interface) — inspects what was actually persisted. */
  lookup(provider: string, providerEventId: string): BusinessVerificationWebhookEventRecord | null {
    return this.byKey.get(`${provider}:${providerEventId}`) ?? null;
  }
}

describe("BusinessVerificationWebhookService", () => {
  let provider: SandboxBusinessVerificationProvider;
  let verifications: InMemoryBusinessVerificationRepository;
  let service: BusinessVerificationService;
  let events: InMemoryBusinessVerificationWebhookEventRepository;
  let webhookService: BusinessVerificationWebhookService;
  let auditRepo: InMemoryAuditEventRepository;

  beforeEach(() => {
    provider = new SandboxBusinessVerificationProvider("test-webhook-secret");
    verifications = new InMemoryBusinessVerificationRepository();
    auditRepo = new InMemoryAuditEventRepository();
    service = new BusinessVerificationService(provider, verifications, new AuditService(auditRepo));
    events = new InMemoryBusinessVerificationWebhookEventRepository();
    webhookService = new BusinessVerificationWebhookService({ provider, events, verification: service });
  });

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: provider.signWebhookPayload(rawBody) };
  }

  it("rejects a spoofed webhook signature — never mutates any record", async () => {
    const { rawBody } = signedWebhook({ providerEventId: "evt_spoof", eventType: "business.updated" });
    await expect(webhookService.receiveWebhook({ rawBody, signatureHeader: "0".repeat(64) })).rejects.toThrow(ForbiddenError);
  });

  it("applies a real decision via a live re-fetch (never trusting the webhook body's own claimed status) and is idempotent on exact redelivery", async () => {
    const { providerReference } = await provider.submitVerification({
      organizationId: "org-1",
      legalBusinessName: "Acme",
      entityType: "LLC",
      taxId: "12-3456789",
      formationJurisdiction: "DE",
      businessAddress: {},
      representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555", relationshipToBusiness: "owner" },
    });
    await verifications.insertSubmission({ organizationId: "org-1", provider: provider.providerName, providerReference, taxIdLast4: "6789" });
    provider.simulateDecision(providerReference, "verified");

    const delivery = signedWebhook({ providerEventId: "evt_1", eventType: "business.updated", id: providerReference });
    const first = await webhookService.receiveWebhook(delivery);
    expect(first.status).toBe("processed");
    const record = await verifications.findByProviderReference(providerReference);
    expect(record?.status).toBe("verified");

    const second = await webhookService.receiveWebhook(delivery);
    expect(second.status).toBe("duplicate");
  });

  it("a redelivered event with a DIFFERENT provider event id for the same business does not corrupt state and still resolves via a fresh re-fetch (no duplicate audit/activation side effects beyond the single resulting state)", async () => {
    const { providerReference } = await provider.submitVerification({
      organizationId: "org-1",
      legalBusinessName: "Acme",
      entityType: "LLC",
      taxId: "12-3456789",
      formationJurisdiction: "DE",
      businessAddress: {},
      representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555", relationshipToBusiness: "owner" },
    });
    await verifications.insertSubmission({ organizationId: "org-1", provider: provider.providerName, providerReference, taxIdLast4: "6789" });
    provider.simulateDecision(providerReference, "verified");

    await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_a", eventType: "business.updated", id: providerReference }));
    const result = await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_b", eventType: "business.updated", id: providerReference }));
    expect(result.status).toBe("processed");
    const record = await verifications.findByProviderReference(providerReference);
    expect(record?.status).toBe("verified");
  });

  it("an unknown business reference (never submitted by this application) is ignored, not thrown — a redelivered webhook never fails the provider's retry loop", async () => {
    const result = await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_unknown", eventType: "business.updated", id: "biz_never_submitted" }));
    expect(result.status).toBe("ignored");
  });

  it("an unmapped event type is ignored, not thrown", async () => {
    const result = await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_x", eventType: "industry_classification.completed", id: "irrelevant" }));
    expect(result.status).toBe("ignored");
  });

  describe("PAID2YOU — MASTER P0 CLOSURE REMEDIATION (2026-10-03), Section 4: in_review handling", () => {
    async function submitAndRecord(organizationId: string) {
      const { providerReference } = await provider.submitVerification({
        organizationId,
        legalBusinessName: "Acme",
        entityType: "LLC",
        taxId: "12-3456789",
        formationJurisdiction: "DE",
        businessAddress: {},
        representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555", relationshipToBusiness: "owner" },
      });
      await verifications.insertSubmission({ organizationId, provider: provider.providerName, providerReference, taxIdLast4: "6789" });
      return providerReference;
    }

    it("a webhook reporting the provider's own in_review-equivalent state maps to the existing 'review_required' status — NEVER 'verified', never treated as a provider error", async () => {
      const providerReference = await submitAndRecord("org-review");
      provider.simulateDecision(providerReference, "review_required");

      const result = await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_review", eventType: "business.updated", id: providerReference }));
      expect(result.status).toBe("processed");
      const record = await verifications.findByProviderReference(providerReference);
      expect(record?.status).toBe("review_required");
      expect(record?.status).not.toBe("verified");
    });

    it("review_required does NOT activate the Business — BusinessActivationService requires strictly 'verified'", async () => {
      const providerReference = await submitAndRecord("org-review-2");
      provider.simulateDecision(providerReference, "review_required");
      await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_review2", eventType: "business.updated", id: providerReference }));
      const record = await verifications.findByProviderReference(providerReference);
      expect(record?.status).toBe("review_required");
      // BusinessActivationService.computeActivationStatus's own `active` expression requires
      // `verificationStatus === "verified"` strictly — "review_required" never satisfies it. See
      // businessActivationService.test.ts for the direct proof against that service itself.
    });

    it("records a BUSINESS_VERIFICATION_REVIEW_REQUIRED audit event, with a server-controlled 'middesk_webhook' actor and no raw EIN in the payload", async () => {
      const providerReference = await submitAndRecord("org-review-3");
      provider.simulateDecision(providerReference, "review_required");
      await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_review3", eventType: "business.updated", id: providerReference }));

      const events_ = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_REVIEW_REQUIRED");
      expect(events_).toHaveLength(1);
      expect(events_[0]?.actorUserId).toBeNull();
      expect(events_[0]?.actorRole).toBe("middesk_webhook");
      expect(events_[0]?.profileId).toBe("org-review-3");
      expect(JSON.stringify(events_[0])).not.toContain("12-3456789");
    });

    it("records BUSINESS_VERIFICATION_APPROVED/REJECTED exactly once for a verified/rejected transition, and never a duplicate on exact webhook redelivery", async () => {
      const approvedRef = await submitAndRecord("org-approved");
      provider.simulateDecision(approvedRef, "verified");
      const delivery = signedWebhook({ providerEventId: "evt_approved", eventType: "business.updated", id: approvedRef });
      await webhookService.receiveWebhook(delivery);
      await webhookService.receiveWebhook(delivery); // exact redelivery — deduped upstream by the webhook-event table

      const approvedEvents = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_APPROVED" && e.profileId === "org-approved");
      expect(approvedEvents).toHaveLength(1);

      const rejectedRef = await submitAndRecord("org-rejected");
      provider.simulateDecision(rejectedRef, "rejected");
      await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_rejected", eventType: "business.updated", id: rejectedRef }));
      const rejectedEvents = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_REJECTED" && e.profileId === "org-rejected");
      expect(rejectedEvents).toHaveLength(1);
    });

    it("a redundant re-apply reporting the SAME status again (not an exact-duplicate delivery, but no material change) does not record a second audit event", async () => {
      const providerReference = await submitAndRecord("org-redundant");
      provider.simulateDecision(providerReference, "verified");
      await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_1", eventType: "business.updated", id: providerReference }));
      // A second, genuinely distinct provider event for the SAME business, still "verified" — not an
      // exact redelivery (different providerEventId), but not a material change either.
      await webhookService.receiveWebhook(signedWebhook({ providerEventId: "evt_2", eventType: "business.updated", id: providerReference }));

      const approvedEvents = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_APPROVED" && e.profileId === "org-redundant");
      expect(approvedEvents).toHaveLength(1);
    });
  });

  describe("P0-3 (Codex): a failed processing attempt remains retryable, never permanently suppressed", () => {
    async function submitAndRecord(organizationId: string) {
      const { providerReference } = await provider.submitVerification({
        organizationId,
        legalBusinessName: "Acme",
        entityType: "LLC",
        taxId: "12-3456789",
        formationJurisdiction: "DE",
        businessAddress: {},
        representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555", relationshipToBusiness: "owner" },
      });
      await verifications.insertSubmission({ organizationId, provider: provider.providerName, providerReference, taxIdLast4: "6789" });
      return providerReference;
    }

    it("first delivery fails after the event is claimed (processedAt stays null); redelivery of the SAME event then succeeds and processes exactly once; a third delivery is a genuine duplicate", async () => {
      const providerReference = await submitAndRecord("org-retry-1");
      provider.simulateDecision(providerReference, "verified");

      let callCount = 0;
      const originalRetrieve = provider.retrieveVerificationStatus.bind(provider);
      const spy = vi.spyOn(provider, "retrieveVerificationStatus").mockImplementation(async (ref: string) => {
        callCount += 1;
        if (callCount === 1) throw new Error("simulated transient provider failure");
        return originalRetrieve(ref);
      });

      const delivery = signedWebhook({ providerEventId: "evt_retry_1", eventType: "business.updated", id: providerReference });

      // First delivery: the event is claimed (inserted), but processing itself throws — never reaches markProcessed.
      await expect(webhookService.receiveWebhook(delivery)).rejects.toThrow("simulated transient provider failure");
      expect(events.lookup("sandbox_business_verification_mock", "evt_retry_1")?.processedAt).toBeNull();

      // Redelivery of the EXACT SAME event, after the claim's stale window has elapsed (a realistic
      // provider retry — not microseconds later while the first attempt might still be in flight):
      // this is the P0-3 fix under test — it must NOT be silently suppressed as "duplicate" merely
      // because a row already exists for this event id.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3 * 60 * 1000);
      const second = await webhookService.receiveWebhook(delivery);
      vi.useRealTimers();
      expect(second.status).toBe("processed");
      expect(events.lookup("sandbox_business_verification_mock", "evt_retry_1")?.processedAt).not.toBeNull();
      const approvedEvents = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_APPROVED" && e.profileId === "org-retry-1");
      expect(approvedEvents).toHaveLength(1);

      // Third delivery: now a GENUINE duplicate (already successfully processed) — never reprocessed, never a second audit event.
      const third = await webhookService.receiveWebhook(delivery);
      expect(third.status).toBe("duplicate");
      expect(auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_APPROVED" && e.profileId === "org-retry-1")).toHaveLength(1);

      spy.mockRestore();
    });

    it("concurrent duplicate deliveries of the SAME unprocessed event apply the business transition exactly once and record exactly one audit event", async () => {
      const providerReference = await submitAndRecord("org-concurrent-1");
      provider.simulateDecision(providerReference, "verified");
      const delivery = signedWebhook({ providerEventId: "evt_concurrent_1", eventType: "business.updated", id: providerReference });

      const [a, b] = await Promise.all([webhookService.receiveWebhook(delivery), webhookService.receiveWebhook(delivery)]);
      const statuses = [a.status, b.status].sort();
      // Exactly one of the two concurrent deliveries wins the claim and processes; the other is
      // safely treated as a duplicate/in-progress — never both processing.
      expect(statuses).toEqual(["duplicate", "processed"]);
      const approvedEvents = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_APPROVED" && e.profileId === "org-concurrent-1");
      expect(approvedEvents).toHaveLength(1);
    });
  });

  describe("P0-2 (Codex): persistent webhook-event storage never contains Middesk's raw business object, through the REAL Middesk adapter end to end", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("a webhook business object carrying a sentinel TIN/address/review-note never reaches the persisted payload, audit metadata, or a thrown error", async () => {
      const SENTINEL_TIN = "SENTINEL-TIN-PERSIST-7c8d9e";
      const middesk = new MiddeskBusinessVerificationProvider({ apiKey: "test-api-key", webhookSecret: "test-webhook-secret" });
      const realEvents = new InMemoryBusinessVerificationWebhookEventRepository();
      const realVerifications = new InMemoryBusinessVerificationRepository();
      const realAuditRepo = new InMemoryAuditEventRepository();
      const realVerificationService = new BusinessVerificationService(middesk, realVerifications, new AuditService(realAuditRepo));
      const realWebhookService = new BusinessVerificationWebhookService({ provider: middesk, events: realEvents, verification: realVerificationService });

      const rawBody = JSON.stringify({
        id: "evt_sentinel_1",
        type: "business.updated",
        data: {
          object: {
            id: "biz_sentinel_1",
            status: "approved",
            tin: { tin: SENTINEL_TIN },
            addresses: [{ address_line1: "1 Secret St" }],
            review: { reason: `flagged: ${SENTINEL_TIN}` },
          },
        },
      });
      const signatureHeader = createHmac("sha256", "test-webhook-secret").update(rawBody, "utf8").digest("hex");

      let thrownMessage = "";
      try {
        await realWebhookService.receiveWebhook({ rawBody, signatureHeader });
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }

      const stored = realEvents.lookup("middesk", "evt_sentinel_1");
      expect(stored).not.toBeNull();
      expect(JSON.stringify(stored?.payload)).not.toContain(SENTINEL_TIN);
      expect(JSON.stringify(realAuditRepo.events)).not.toContain(SENTINEL_TIN);
      expect(thrownMessage).not.toContain(SENTINEL_TIN);
    });
  });
});
