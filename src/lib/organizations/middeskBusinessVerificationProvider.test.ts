import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mapMiddeskStatus, MiddeskBusinessVerificationProvider } from "./middeskBusinessVerificationProvider";

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 57: contract tests for the real Middesk adapter,
 * using a stubbed `fetch` (never a live network call — no Middesk credentials exist in this
 * environment). Proves: correct request mapping, submission !== verification, status mapping,
 * webhook signature verification (valid/invalid), idempotent-safe parsing, and — Section 12's own
 * data-minimization requirement — that the raw Tax ID never appears in any thrown error message or
 * returned value from this adapter.
 */
describe("MiddeskBusinessVerificationProvider", () => {
  const RAW_TAX_ID = "12-3456789";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function provider() {
    return new MiddeskBusinessVerificationProvider({ apiKey: "test-api-key", webhookSecret: "test-webhook-secret" });
  }

  describe("mapMiddeskStatus", () => {
    it("maps every documented Middesk status to the correct existing BusinessVerificationResultStatus", () => {
      expect(mapMiddeskStatus("open")).toBe("pending");
      expect(mapMiddeskStatus("pending")).toBe("pending");
      expect(mapMiddeskStatus("in_audit")).toBe("pending");
      expect(mapMiddeskStatus("in_review")).toBe("review_required");
      expect(mapMiddeskStatus("approved")).toBe("verified");
      expect(mapMiddeskStatus("rejected")).toBe("rejected");
    });

    it("maps an unknown/future status conservatively to 'pending' — never fabricates 'verified'", () => {
      expect(mapMiddeskStatus("some_future_status_middesk_adds_later")).toBe("pending");
    });
  });

  describe("submitVerification", () => {
    it("POSTs to /v1/businesses with Bearer auth and the correctly-mapped request body, including the raw TIN exactly once", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "biz_123", object: "business", status: "open" }), { status: 200 }));

      const result = await provider().submitVerification({
        organizationId: "org-1",
        legalBusinessName: "Acme Freight LLC",
        entityType: "LLC",
        taxId: RAW_TAX_ID,
        formationJurisdiction: "DE",
        businessAddress: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701" },
        representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555-0100", relationshipToBusiness: "owner" },
      });

      expect(result.providerReference).toBe("biz_123");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.middesk.com/v1/businesses");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
      const body = JSON.parse(init.body as string);
      expect(body.name).toBe("Acme Freight LLC");
      expect(body.tin.tin).toBe(RAW_TAX_ID);
      expect(body.addresses[0].address_city).toBe("Austin");
    });

    it("submission alone never reports 'verified' — a fresh 'open' business maps to 'pending' via a subsequent retrieveVerificationStatus call", async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: "biz_456", object: "business", status: "open" }), { status: 200 }));
      const p = provider();
      await p.submitVerification({
        organizationId: "org-1",
        legalBusinessName: "Acme",
        entityType: "LLC",
        taxId: RAW_TAX_ID,
        formationJurisdiction: "DE",
        businessAddress: {},
        representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555-0100", relationshipToBusiness: "owner" },
      });
      const status = await p.retrieveVerificationStatus("biz_456");
      expect(status.status).toBe("pending");
    });

    it("DATA MINIMIZATION: a Middesk error response's thrown ConfigurationError message never contains the raw Tax ID", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "Invalid business" }), { status: 422 }));
      let thrownMessage = "";
      try {
        await provider().submitVerification({
          organizationId: "org-1",
          legalBusinessName: "Acme",
          entityType: "LLC",
          taxId: RAW_TAX_ID,
          formationJurisdiction: "DE",
          businessAddress: {},
          representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555-0100", relationshipToBusiness: "owner" },
        });
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }
      expect(thrownMessage).not.toContain(RAW_TAX_ID);
      expect(thrownMessage.length).toBeGreaterThan(0);
    });

    it("P0-2 (Codex): never echoes Middesk's own error response body text into the thrown error, under any content — not just the raw Tax ID specifically", async () => {
      const SENTINEL = "SENTINEL-PROVIDER-BODY-TEXT-9f3e1c";
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: `Rejected: ${SENTINEL}`, error_code: SENTINEL }), { status: 422 }));
      let thrownMessage = "";
      try {
        await provider().submitVerification({
          organizationId: "org-1",
          legalBusinessName: "Acme",
          entityType: "LLC",
          taxId: RAW_TAX_ID,
          formationJurisdiction: "DE",
          businessAddress: {},
          representative: { firstName: "Jo", lastName: "Doe", title: "CEO", email: "jo@acme.test", phone: "555-0100", relationshipToBusiness: "owner" },
        });
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }
      expect(thrownMessage).not.toContain(SENTINEL);
      expect(thrownMessage).toContain("Middesk");
      expect(thrownMessage).toContain("422");
    });
  });

  describe("P0-2 (Codex): webhook business-object persistence is allowlisted, never the raw object", () => {
    it("parseWebhookEvent strips TIN-adjacent/unlisted fields from the business object — only id/status/created_at/updated_at survive", () => {
      const SENTINEL_TIN = "SENTINEL-TIN-1a2b3c4d5e";
      const rawBody = JSON.stringify({
        id: "evt_99",
        type: "business.updated",
        data: {
          object: {
            id: "biz_99",
            status: "approved",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            tin: { tin: SENTINEL_TIN },
            addresses: [{ address_line1: "1 Secret St" }],
            review: { reason: "manual notes mentioning " + SENTINEL_TIN },
          },
        },
      });
      const parsed = provider().parseWebhookEvent(rawBody);
      const serialized = JSON.stringify(parsed.data);
      expect(serialized).not.toContain(SENTINEL_TIN);
      expect(parsed.data).toEqual({ id: "biz_99", status: "approved", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" });
    });
  });

  describe("retrieveVerificationStatus", () => {
    it("GETs /v1/businesses/:id and maps 'approved' to 'verified'", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "biz_1", status: "approved" }), { status: 200 }));
      const result = await provider().retrieveVerificationStatus("biz_1");
      expect(result.status).toBe("verified");
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.middesk.com/v1/businesses/biz_1");
    });

    it("maps 'in_review' to 'review_required' with reviewRequired=true — never auto-decides approve/reject (Section 16: that is an operator action in Middesk's own dashboard)", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "biz_2", status: "in_review", review: { reason: "name mismatch" } }), { status: 200 }));
      const result = await provider().retrieveVerificationStatus("biz_2");
      expect(result.status).toBe("review_required");
      expect(result.reviewRequired).toBe(true);
    });

    it("maps 'rejected' to a fixed, closed failureCode literal — never the raw provider payload", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "biz_3", status: "rejected", review: { reason: "entity not found" } }), { status: 200 }));
      const result = await provider().retrieveVerificationStatus("biz_3");
      expect(result.status).toBe("rejected");
      expect(result.failureCode).toBe("rejected");
    });

    // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-2 (Codex re-verification): the prior
    // fix only sanitized the webhook JSONB payload path; this adversarial sentinel proves the SEPARATE
    // `retrieveVerificationStatus` → `failureCode` path (the one Codex found) can no longer leak
    // Middesk's own free-text `review.reason` into the returned result at all — the exact value that
    // flows, unsanitized, into `business_verification.failure_code` and audit `newValue.failureCode`
    // in BusinessVerificationService.applyVerificationResult.
    it("never surfaces a sentinel planted in review.reason via failureCode, no matter how it is worded", async () => {
      const SENTINEL_REASON = "P2Y_TEST_REASON_99-9999999_SECRET_SENTINEL";
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ id: "biz_4", status: "rejected", review: { reason: SENTINEL_REASON } }), { status: 200 }),
      );
      const result = await provider().retrieveVerificationStatus("biz_4");
      expect(result.failureCode).not.toContain(SENTINEL_REASON);
      expect(JSON.stringify(result)).not.toContain(SENTINEL_REASON);
    });
  });

  describe("request() network failure", () => {
    // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-2 (Codex re-verification): a caught
    // network/fetch exception's own `.message` must never reach the thrown error's message, since
    // `withErrorHandling`'s generic catch-all logs that message verbatim to production logs.
    it("never interpolates the caught network exception's own message into the thrown error", async () => {
      const SENTINEL_NETWORK_MESSAGE = "P2Y_TEST_NETWORK_SECRET_SENTINEL_connect ECONNREFUSED 10.0.0.1:443";
      fetchMock.mockRejectedValue(new Error(SENTINEL_NETWORK_MESSAGE));
      await expect(provider().retrieveVerificationStatus("biz_5")).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(SENTINEL_NETWORK_MESSAGE);
        return true;
      });
    });
  });

  describe("webhook signature verification", () => {
    it("accepts a correctly HMAC-SHA256-signed raw body via the X-Middesk-Signature-256 convention", () => {
      const p = provider();
      const rawBody = JSON.stringify({ id: "evt_1", type: "business.updated", data: { object: { id: "biz_1" } } });
      const signature = createHmac("sha256", "test-webhook-secret").update(rawBody, "utf8").digest("hex");
      expect(p.verifyWebhookSignature(rawBody, signature)).toBe(true);
    });

    it("rejects a tampered body even with a plausible-looking signature", () => {
      const p = provider();
      const rawBody = JSON.stringify({ id: "evt_1", type: "business.updated", data: { object: { id: "biz_1" } } });
      const wrongSignature = createHmac("sha256", "wrong-secret").update(rawBody, "utf8").digest("hex");
      expect(p.verifyWebhookSignature(rawBody, wrongSignature)).toBe(false);
    });

    it("rejects a missing signature header outright, never treating empty as valid", () => {
      expect(provider().verifyWebhookSignature("{}", "")).toBe(false);
    });

    it("parseWebhookEvent extracts id/type/data.object correctly", () => {
      const rawBody = JSON.stringify({ id: "evt_42", type: "business.updated", data: { object: { id: "biz_1", status: "approved" } } });
      const parsed = provider().parseWebhookEvent(rawBody);
      expect(parsed.provider).toBe("middesk");
      expect(parsed.providerEventId).toBe("evt_42");
      expect(parsed.eventType).toBe("business.updated");
      expect(parsed.data).toEqual({ id: "biz_1", status: "approved" });
    });
  });
});
