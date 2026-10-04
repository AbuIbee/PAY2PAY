import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { SandboxBusinessVerificationProvider } from "@/test-support/organizations/sandboxBusinessVerificationProvider";
import { BusinessVerificationService } from "@/lib/organizations/businessVerificationService";
import { InMemoryBusinessVerificationRepository } from "@/lib/organizations/businessVerificationTestFakes";
import { BusinessVerificationWebhookService } from "@/lib/organizations/businessVerificationWebhookService";
import { createMiddeskWebhookHandler } from "./route";

function buildRequest(rawBody: string, signatureHeader: string) {
  return new NextRequest("http://localhost/api/webhooks/business-verification/middesk", {
    method: "POST",
    headers: { "x-middesk-signature-256": signatureHeader },
    body: rawBody,
  });
}

describe("POST /api/webhooks/business-verification/middesk", () => {
  function buildService() {
    const provider = new SandboxBusinessVerificationProvider("test-secret");
    const service = new BusinessVerificationWebhookService({
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
      verification: new BusinessVerificationService(provider, new InMemoryBusinessVerificationRepository(), new AuditService(new InMemoryAuditEventRepository())),
    });
    return { provider, service };
  }

  it("rejects an invalid signature with 403", async () => {
    const { service } = buildService();
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "business.updated", id: "biz_1" });
    const response = await withErrorHandling("test", createMiddeskWebhookHandler(service))(buildRequest(rawBody, "0".repeat(64)));
    expect(response.status).toBe(403);
  });

  it("accepts a validly-signed, unmapped-reference delivery with 200 and status 'ignored'", async () => {
    const { provider, service } = buildService();
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "business.updated", id: "biz_never_submitted" });
    const signature = provider.signWebhookPayload(rawBody);
    const response = await withErrorHandling("test", createMiddeskWebhookHandler(service))(buildRequest(rawBody, signature));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ignored");
  });

  it("is idempotent — the exact same event delivered twice returns 'ignored' then 'duplicate', both 200", async () => {
    const { provider, service } = buildService();
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "business.updated", id: "biz_never_submitted" });
    const signature = provider.signWebhookPayload(rawBody);
    const first = await withErrorHandling("test", createMiddeskWebhookHandler(service))(buildRequest(rawBody, signature));
    const second = await withErrorHandling("test", createMiddeskWebhookHandler(service))(buildRequest(rawBody, signature));
    expect((await first.json()).status).toBe("ignored");
    expect((await second.json()).status).toBe("duplicate");
    expect(second.status).toBe(200);
  });
});
