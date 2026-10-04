import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { withErrorHandling } from "@/lib/api-handler";
import { InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { InMemoryBusinessProfileRepository } from "@/lib/profiles/testFakes";
import { SandboxPlatformBillingProvider } from "@/test-support/organizations/sandboxPlatformBillingProvider";
import { InMemorySubscriptionInvoiceRepository, InMemorySubscriptionPaymentMethodRepository } from "@/lib/organizations/platformBillingTestFakes";
import { PlatformBillingWebhookService } from "@/lib/organizations/platformBillingWebhookService";
import { createStripeBillingWebhookHandler } from "./route";

function buildRequest(rawBody: string, signatureHeader: string) {
  return new NextRequest("http://localhost/api/webhooks/billing/stripe", {
    method: "POST",
    headers: { "stripe-signature": signatureHeader },
    body: rawBody,
  });
}

describe("POST /api/webhooks/billing/stripe", () => {
  function buildService() {
    const provider = new SandboxPlatformBillingProvider("test-secret");
    const service = new PlatformBillingWebhookService({
      provider,
      events: new (class {
        private byKey = new Map<string, { id: string; provider: string; providerEventId: string; eventType: string; signatureVerified: boolean; payload: unknown; receivedAt: Date; processedAt: Date | null; claimedAt: Date | null }>();
        async claimEvent(input: { provider: string; providerEventId: string; eventType: string; signatureVerified: boolean; payload: unknown; staleClaimMs: number }) {
          const key = `${input.provider}:${input.providerEventId}`;
          const now = new Date();
          const existing = this.byKey.get(key);
          if (existing) {
            const claimIsFresh = existing.claimedAt && now.getTime() - existing.claimedAt.getTime() < input.staleClaimMs;
            if (existing.processedAt || claimIsFresh) return null;
            existing.claimedAt = now;
            return existing;
          }
          const record = { id: key, provider: input.provider, providerEventId: input.providerEventId, eventType: input.eventType, signatureVerified: input.signatureVerified, payload: input.payload, receivedAt: now, processedAt: null, claimedAt: now };
          this.byKey.set(key, record);
          return record;
        }
        async markProcessed(id: string) {
          const record = this.byKey.get(id);
          if (record) record.processedAt = new Date();
        }
      })(),
      subscriptions: new InMemorySubscriptionRepository(),
      invoices: new InMemorySubscriptionInvoiceRepository(),
      paymentMethods: new InMemorySubscriptionPaymentMethodRepository(),
      audit: new AuditService(new InMemoryAuditEventRepository()),
      businessProfiles: new InMemoryBusinessProfileRepository(),
    });
    return { provider, service };
  }

  it("rejects an invalid signature with 403", async () => {
    const { service } = buildService();
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "invoice.paid", id: "in_1" });
    const response = await withErrorHandling("test", createStripeBillingWebhookHandler(service))(buildRequest(rawBody, "0".repeat(64)));
    expect(response.status).toBe(403);
  });

  it("accepts a validly-signed, unrecognized-subscription delivery with 200 and status 'ignored'", async () => {
    const { provider, service } = buildService();
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "invoice.paid", id: "in_1", subscription: "sandbox_sub_never_existed" });
    const signature = provider.signWebhookPayload(rawBody);
    const response = await withErrorHandling("test", createStripeBillingWebhookHandler(service))(buildRequest(rawBody, signature));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ignored");
  });

  it("is idempotent — the exact same event delivered twice returns 'ignored' then 'duplicate', both 200", async () => {
    const { provider, service } = buildService();
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "invoice.paid", id: "in_1", subscription: "sandbox_sub_never_existed" });
    const signature = provider.signWebhookPayload(rawBody);
    const first = await withErrorHandling("test", createStripeBillingWebhookHandler(service))(buildRequest(rawBody, signature));
    const second = await withErrorHandling("test", createStripeBillingWebhookHandler(service))(buildRequest(rawBody, signature));
    expect((await first.json()).status).toBe("ignored");
    expect((await second.json()).status).toBe("duplicate");
    expect(second.status).toBe(200);
  });
});
