import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import type { PartialPaymentService } from "@/lib/partialPayments/partialPaymentService";
import type { SettlementService } from "@/lib/settlements/settlementService";
import { createExpireNegotiationsHandler, GET, POST } from "./route";

const TEST_CRON_SECRET = "test-cron-secret-0123456789abcdef";

function requestWithAuth(method: "GET" | "POST", authHeader?: string) {
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return new NextRequest("http://localhost/api/scheduler/expire-negotiations", { method, headers });
}

/**
 * Route-level tests exercise only this route's own auth/dispatch wiring — the actual expiration
 * business logic (`PartialPaymentService.expireOverdue`, `SettlementService.expireOverdueSettlements`)
 * already has its own dedicated, unmodified suite in partialPaymentService.test.ts and
 * settlementService.test.ts. Minimal stubs in place of the full agreement/payment test context keep
 * these tests focused on what this remediation actually changed: GET now reaches the same
 * authenticated handler as POST.
 */
function createExpireStubs() {
  const partialPaymentCalls: (Date | undefined)[] = [];
  const settlementCalls: (Date | undefined)[] = [];
  const partialPaymentService = {
    expireOverdue: async (now?: Date) => {
      partialPaymentCalls.push(now);
      return { expired: 2 };
    },
  } as unknown as PartialPaymentService;
  const settlementService = {
    expireOverdueSettlements: async (now?: Date) => {
      settlementCalls.push(now);
      return { resolved: 1 };
    },
  } as unknown as SettlementService;
  return { partialPaymentService, settlementService, partialPaymentCalls, settlementCalls };
}

describe("scheduler/expire-negotiations", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  function handler(partialPaymentService: PartialPaymentService, settlementService: SettlementService) {
    return withErrorHandling("scheduler_expire_negotiations", createExpireNegotiationsHandler(partialPaymentService, settlementService));
  }

  it("exports GET as the exact same handler reference as POST — no duplicated scheduler logic", () => {
    expect(GET).toBe(POST);
  });

  describe("POST (existing behavior, unregressed)", () => {
    it("rejects a request with no authorization header (403) and never calls either expiration service", async () => {
      const { partialPaymentService, settlementService, partialPaymentCalls, settlementCalls } = createExpireStubs();
      const response = await handler(partialPaymentService, settlementService)(requestWithAuth("POST"));
      expect(response.status).toBe(403);
      expect(partialPaymentCalls).toHaveLength(0);
      expect(settlementCalls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls either expiration service", async () => {
      const { partialPaymentService, settlementService, partialPaymentCalls, settlementCalls } = createExpireStubs();
      const response = await handler(partialPaymentService, settlementService)(requestWithAuth("POST", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(partialPaymentCalls).toHaveLength(0);
      expect(settlementCalls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and expires due negotiations and settlements", async () => {
      const { partialPaymentService, settlementService, partialPaymentCalls, settlementCalls } = createExpireStubs();
      const response = await handler(partialPaymentService, settlementService)(requestWithAuth("POST", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", partialPayments: { expired: 2 }, settlements: { resolved: 1 } });
      expect(partialPaymentCalls).toHaveLength(1);
      expect(settlementCalls).toHaveLength(1);
    });
  });

  describe("GET (Vercel Cron support, remediation 01)", () => {
    it("rejects a request with no authorization header (403) and never calls either expiration service", async () => {
      const { partialPaymentService, settlementService, partialPaymentCalls, settlementCalls } = createExpireStubs();
      const response = await handler(partialPaymentService, settlementService)(requestWithAuth("GET"));
      expect(response.status).toBe(403);
      expect(partialPaymentCalls).toHaveLength(0);
      expect(settlementCalls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls either expiration service", async () => {
      const { partialPaymentService, settlementService, partialPaymentCalls, settlementCalls } = createExpireStubs();
      const response = await handler(partialPaymentService, settlementService)(requestWithAuth("GET", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(partialPaymentCalls).toHaveLength(0);
      expect(settlementCalls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and expires due negotiations and settlements, identically to POST", async () => {
      const { partialPaymentService, settlementService, partialPaymentCalls, settlementCalls } = createExpireStubs();
      const response = await handler(partialPaymentService, settlementService)(requestWithAuth("GET", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", partialPayments: { expired: 2 }, settlements: { resolved: 1 } });
      expect(partialPaymentCalls).toHaveLength(1);
      expect(settlementCalls).toHaveLength(1);
    });
  });
});
