import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementInvitationService } from "@/lib/agreementInvitations/agreementInvitationService";
import { createExpireAgreementInvitationsHandler, GET, POST } from "./route";

const TEST_CRON_SECRET = "test-cron-secret-0123456789abcdef";

function requestWithAuth(method: "GET" | "POST", authHeader?: string) {
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return new NextRequest("http://localhost/api/scheduler/expire-agreement-invitations", { method, headers });
}

/**
 * Route-level tests exercise only this route's own auth/dispatch wiring — the actual expiration
 * business logic (`AgreementInvitationService.expireDueInvitations`) is unmodified by this
 * remediation. A minimal stub in place of the full agreement/relationship test context keeps these
 * tests focused on what changed: GET now reaches the same authenticated handler as POST.
 */
function createExpireDueInvitationsStub() {
  const calls: (Date | undefined)[] = [];
  const stub = {
    expireDueInvitations: async (now?: Date) => {
      calls.push(now);
      return { expired: 4 };
    },
  } as unknown as AgreementInvitationService;
  return { stub, calls };
}

describe("scheduler/expire-agreement-invitations", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  function handler(service: AgreementInvitationService) {
    return withErrorHandling("scheduler_expire_agreement_invitations", createExpireAgreementInvitationsHandler(service));
  }

  it("exports GET as the exact same handler reference as POST — no duplicated scheduler logic", () => {
    expect(GET).toBe(POST);
  });

  describe("POST (existing behavior, unregressed)", () => {
    it("rejects a request with no authorization header (403) and never calls the invitation expiration service", async () => {
      const { stub, calls } = createExpireDueInvitationsStub();
      const response = await handler(stub)(requestWithAuth("POST"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the invitation expiration service", async () => {
      const { stub, calls } = createExpireDueInvitationsStub();
      const response = await handler(stub)(requestWithAuth("POST", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and expires due agreement invitations", async () => {
      const { stub, calls } = createExpireDueInvitationsStub();
      const response = await handler(stub)(requestWithAuth("POST", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", expired: 4 });
      expect(calls).toHaveLength(1);
    });
  });

  describe("GET (Vercel Cron support, remediation 01)", () => {
    it("rejects a request with no authorization header (403) and never calls the invitation expiration service", async () => {
      const { stub, calls } = createExpireDueInvitationsStub();
      const response = await handler(stub)(requestWithAuth("GET"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("rejects a request with an invalid bearer token (403) and never calls the invitation expiration service", async () => {
      const { stub, calls } = createExpireDueInvitationsStub();
      const response = await handler(stub)(requestWithAuth("GET", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("accepts a request with the correct bearer token (200) and expires due agreement invitations, identically to POST", async () => {
      const { stub, calls } = createExpireDueInvitationsStub();
      const response = await handler(stub)(requestWithAuth("GET", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", expired: 4 });
      expect(calls).toHaveLength(1);
    });
  });
});
