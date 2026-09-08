import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import type { ReconciliationService } from "@/lib/ledger/reconciliationService";
import type { PaymentWebhookService } from "@/lib/payments/paymentWebhookService";
import { createRecoverPaymentWebhooksHandler, GET, POST } from "./route";

const TEST_CRON_SECRET = "test-cron-secret-0123456789abcdef";

function requestWithAuth(method: "GET" | "POST", authHeader?: string) {
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return new NextRequest("http://localhost/api/scheduler/recover-payment-webhooks", { method, headers });
}

/**
 * R06 (webhook processed-state / redelivery recovery) — route-level tests exercise only this route's
 * own auth/dispatch wiring, mirroring retry-failed-payments/route.test.ts's identical precedent and
 * rationale. The actual claim/lease/retry business logic (`PaymentWebhookService.recoverBatch`)
 * already has its own dedicated real-Postgres suite.
 */
function createRecoverBatchStub() {
  const calls: number[] = [];
  const stub = {
    recoverBatch: async (limit: number) => {
      calls.push(limit);
      return { claimed: 1, processed: 1, failed: 0 };
    },
  } as unknown as PaymentWebhookService;
  return { stub, calls };
}

/** R09 corrective pass (Codex blocker 1): the scheduler's second dependency — see route.ts's own doc comment. */
function createRepairBatchStub() {
  const calls: number[] = [];
  const stub = {
    repairBatch: async (limit: number) => {
      calls.push(limit);
      return { scanned: 2, exceptionsFound: 0 };
    },
  } as unknown as ReconciliationService;
  return { stub, calls };
}

describe("scheduler/recover-payment-webhooks", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  function handler(service: PaymentWebhookService, reconciliation: ReconciliationService) {
    return withErrorHandling("scheduler_recover_payment_webhooks", createRecoverPaymentWebhooksHandler(service, reconciliation));
  }

  it("exports GET as the exact same handler reference as POST (R01: Vercel Cron GET compatibility) — no duplicated scheduler logic", () => {
    expect(GET).toBe(POST);
  });

  describe("POST", () => {
    it("rejects a request with no authorization header (403) and never calls the recovery service", async () => {
      const { stub, calls } = createRecoverBatchStub();
      const { stub: reconciliationStub, calls: reconciliationCalls } = createRepairBatchStub();
      const response = await handler(stub, reconciliationStub)(requestWithAuth("POST"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(reconciliationCalls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the recovery service", async () => {
      const { stub, calls } = createRecoverBatchStub();
      const { stub: reconciliationStub, calls: reconciliationCalls } = createRepairBatchStub();
      const response = await handler(stub, reconciliationStub)(requestWithAuth("POST", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(reconciliationCalls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and runs a bounded recovery batch and a bounded reconciliation repair batch", async () => {
      const { stub, calls } = createRecoverBatchStub();
      const { stub: reconciliationStub, calls: reconciliationCalls } = createRepairBatchStub();
      const response = await handler(stub, reconciliationStub)(requestWithAuth("POST", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", claimed: 1, processed: 1, failed: 0, reconciliation: { scanned: 2, exceptionsFound: 0 } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBeGreaterThan(0); // bounded batch size, never unbounded.
      expect(reconciliationCalls).toHaveLength(1);
      expect(reconciliationCalls[0]).toBeGreaterThan(0); // bounded batch size, never unbounded.
    });
  });

  describe("GET (Vercel Cron support)", () => {
    it("rejects a request with no authorization header (403) and never calls the recovery service", async () => {
      const { stub, calls } = createRecoverBatchStub();
      const { stub: reconciliationStub, calls: reconciliationCalls } = createRepairBatchStub();
      const response = await handler(stub, reconciliationStub)(requestWithAuth("GET"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(reconciliationCalls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the recovery service", async () => {
      const { stub, calls } = createRecoverBatchStub();
      const { stub: reconciliationStub, calls: reconciliationCalls } = createRepairBatchStub();
      const response = await handler(stub, reconciliationStub)(requestWithAuth("GET", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(reconciliationCalls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and runs a bounded recovery batch, identically to POST", async () => {
      const { stub, calls } = createRecoverBatchStub();
      const { stub: reconciliationStub, calls: reconciliationCalls } = createRepairBatchStub();
      const response = await handler(stub, reconciliationStub)(requestWithAuth("GET", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", claimed: 1, processed: 1, failed: 0, reconciliation: { scanned: 2, exceptionsFound: 0 } });
      expect(calls).toHaveLength(1);
      expect(reconciliationCalls).toHaveLength(1);
    });
  });
});
