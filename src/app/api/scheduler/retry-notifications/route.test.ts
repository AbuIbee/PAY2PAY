import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import type { NotificationService } from "@/lib/notify/notificationService";
import { createRetryNotificationsHandler, GET, POST } from "./route";

const TEST_CRON_SECRET = "test-cron-secret-0123456789abcdef";

function requestWithAuth(method: "GET" | "POST", authHeader?: string) {
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return new NextRequest("http://localhost/api/scheduler/retry-notifications", { method, headers });
}

/**
 * Route-level tests exercise only this route's own auth/dispatch wiring — the actual retry business
 * logic (`NotificationService.retryDueNotifications`) already has its own dedicated, unmodified suite
 * in notificationService.test.ts. A minimal stub keeps these tests focused on what this remediation
 * actually changed: GET now reaches the same authenticated handler as POST.
 */
function createRetryDueNotificationsStub() {
  const calls: (Date | undefined)[] = [];
  const stub = {
    retryDueNotifications: async (now?: Date) => {
      calls.push(now);
      return { retried: 3, succeeded: 2, failed: 1 };
    },
  } as unknown as NotificationService;
  return { stub, calls };
}

describe("scheduler/retry-notifications", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  function handler(service: NotificationService) {
    return withErrorHandling("scheduler_retry_notifications", createRetryNotificationsHandler(service));
  }

  it("exports GET as the exact same handler reference as POST — no duplicated scheduler logic", () => {
    expect(GET).toBe(POST);
  });

  describe("POST (existing behavior, unregressed)", () => {
    it("rejects a request with no authorization header (403) and never calls the notification retry service", async () => {
      const { stub, calls } = createRetryDueNotificationsStub();
      const response = await handler(stub)(requestWithAuth("POST"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the notification retry service", async () => {
      const { stub, calls } = createRetryDueNotificationsStub();
      const response = await handler(stub)(requestWithAuth("POST", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and retries due notifications", async () => {
      const { stub, calls } = createRetryDueNotificationsStub();
      const response = await handler(stub)(requestWithAuth("POST", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", retried: 3, succeeded: 2, failed: 1 });
      expect(calls).toHaveLength(1);
    });
  });

  describe("GET (Vercel Cron support, remediation 01)", () => {
    it("rejects a request with no authorization header (403) and never calls the notification retry service", async () => {
      const { stub, calls } = createRetryDueNotificationsStub();
      const response = await handler(stub)(requestWithAuth("GET"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the notification retry service", async () => {
      const { stub, calls } = createRetryDueNotificationsStub();
      const response = await handler(stub)(requestWithAuth("GET", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and retries due notifications, identically to POST", async () => {
      const { stub, calls } = createRetryDueNotificationsStub();
      const response = await handler(stub)(requestWithAuth("GET", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", retried: 3, succeeded: 2, failed: 1 });
      expect(calls).toHaveLength(1);
    });
  });
});
