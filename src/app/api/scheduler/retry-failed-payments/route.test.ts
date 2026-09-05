import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import type { PaymentRetryService } from "@/lib/failedPayments/paymentRetryService";
import { createRetryFailedPaymentsHandler, GET, POST } from "./route";

const TEST_CRON_SECRET = "test-cron-secret-0123456789abcdef";

function requestWithAuth(method: "GET" | "POST", authHeader?: string) {
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return new NextRequest("http://localhost/api/scheduler/retry-failed-payments", { method, headers });
}

/**
 * Route-level tests exercise only this route's own auth/dispatch wiring — the actual retry business
 * logic (`PaymentRetryService.fireDueRetries`) already has its own dedicated, unmodified suite in
 * paymentRetryService.test.ts. A minimal stub in place of the full ACH/mandate/verification test
 * context keeps these tests focused on what this remediation actually changed: GET now reaches the
 * same authenticated handler as POST.
 */
function createFireDueRetriesStub() {
  const calls: (Date | undefined)[] = [];
  const stub = {
    fireDueRetries: async (now?: Date) => {
      calls.push(now);
      return { fired: 1, canceled: 0 };
    },
  } as unknown as PaymentRetryService;
  return { stub, calls };
}

describe("scheduler/retry-failed-payments", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  function handler(service: PaymentRetryService) {
    return withErrorHandling("scheduler_retry_failed_payments", createRetryFailedPaymentsHandler(service));
  }

  it("exports GET as the exact same handler reference as POST — no duplicated scheduler logic", () => {
    expect(GET).toBe(POST);
  });

  describe("POST (existing behavior, unregressed)", () => {
    it("rejects a request with no authorization header (403) and never calls the retry service", async () => {
      const { stub, calls } = createFireDueRetriesStub();
      const response = await handler(stub)(requestWithAuth("POST"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the retry service", async () => {
      const { stub, calls } = createFireDueRetriesStub();
      const response = await handler(stub)(requestWithAuth("POST", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and fires due retries", async () => {
      const { stub, calls } = createFireDueRetriesStub();
      const response = await handler(stub)(requestWithAuth("POST", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", fired: 1, canceled: 0 });
      expect(calls).toHaveLength(1);
    });
  });

  describe("GET (Vercel Cron support, remediation 01)", () => {
    it("rejects a request with no authorization header (403) and never calls the retry service", async () => {
      const { stub, calls } = createFireDueRetriesStub();
      const response = await handler(stub)(requestWithAuth("GET"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the retry service", async () => {
      const { stub, calls } = createFireDueRetriesStub();
      const response = await handler(stub)(requestWithAuth("GET", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and fires due retries, identically to POST", async () => {
      const { stub, calls } = createFireDueRetriesStub();
      const response = await handler(stub)(requestWithAuth("GET", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", fired: 1, canceled: 0 });
      expect(calls).toHaveLength(1);
    });
  });
});
