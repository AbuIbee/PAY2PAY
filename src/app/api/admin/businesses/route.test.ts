import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestAdminService } from "@/lib/admin/testFakes";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createAdminBusinessesSearchHandler } from "./route";
import { createAdminBusinessDetailHandler } from "./detail/route";
import { createAdminReactivateBusinessHandler } from "./reactivate/route";
import { createAdminSuspendBusinessHandler } from "./suspend/route";

/**
 * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md) — route-level
 * (not just service-level) negative-security coverage for every new /api/admin/businesses/* route,
 * mirroring overview/route.test.ts's exact pattern: no session (401), a real session belonging to an
 * ordinary Member (403) even though the session itself is genuine, and a real Platform Admin session
 * reaching the route successfully (200/403-by-business-rule as appropriate).
 */
describe("/api/admin/businesses/*", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let adminCtx: ReturnType<typeof createTestAdminService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    adminCtx = createTestAdminService();
  });

  function withCookie(url: string, sessionToken?: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) {
    const headers = { ...init?.headers, ...(sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {}) };
    return new NextRequest(url, { method: init?.method, body: init?.body, headers });
  }

  async function signUpWithRole(email: string, role: "member" | "platform_admin" | "platform_owner") {
    const result = await authCtx.authService.signup({ email, password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    if (role !== "member") authCtx.users.setPlatformRole(result.user.id, role);
    return result;
  }

  describe("GET /api/admin/businesses (search)", () => {
    function handler() {
      return withErrorHandling("admin_businesses_search", createAdminBusinessesSearchHandler(authCtx.authService, adminCtx.adminService));
    }

    it("rejects a request with no session (401)", async () => {
      const response = await handler()(withCookie("http://localhost/api/admin/businesses"));
      expect(response.status).toBe(401);
    });

    it("rejects an ordinary Member's genuine session (403)", async () => {
      const { token } = await signUpWithRole("member@example.com", "member");
      const response = await handler()(withCookie("http://localhost/api/admin/businesses", token));
      expect(response.status).toBe(403);
    });

    it("accepts a Platform Admin session (200)", async () => {
      const { token } = await signUpWithRole("admin@example.com", "platform_admin");
      const response = await handler()(withCookie("http://localhost/api/admin/businesses", token));
      expect(response.status).toBe(200);
    });
  });

  describe("GET /api/admin/businesses/detail", () => {
    function handler() {
      return withErrorHandling("admin_business_detail", createAdminBusinessDetailHandler(authCtx.authService, adminCtx.adminService));
    }

    it("rejects a request with no session (401)", async () => {
      const response = await handler()(withCookie("http://localhost/api/admin/businesses/detail?id=x"));
      expect(response.status).toBe(401);
    });

    it("rejects an ordinary Member's genuine session (403)", async () => {
      const { token } = await signUpWithRole("member2@example.com", "member");
      const response = await handler()(withCookie("http://localhost/api/admin/businesses/detail?id=x", token));
      expect(response.status).toBe(403);
    });

    it("a Platform Admin viewing a real business gets 200 with the right owner", async () => {
      const owner = await adminCtx.users.insert({ email: "owner@example.com", authCredentialRef: "x", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH });
      const business = await adminCtx.businesses.insert({
        ownerUserId: owner.id,
        legalBusinessName: "Acme LLC",
        displayName: "Acme",
        entityType: "llc",
        businessAddress: null,
        country: "US",
        state: "CA",
      });
      const { token } = await signUpWithRole("admin2@example.com", "platform_admin");
      const response = await handler()(withCookie(`http://localhost/api/admin/businesses/detail?id=${business.id}`, token));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ownerEmail: string };
      expect(body.ownerEmail).toBe("owner@example.com");
    });

    it("a nonexistent business id is a 400 validation error, not a leak of existence via a different status", async () => {
      const { token } = await signUpWithRole("admin3@example.com", "platform_admin");
      const response = await handler()(withCookie("http://localhost/api/admin/businesses/detail?id=00000000-0000-0000-0000-000000000000", token));
      expect(response.status).toBe(400);
    });
  });

  describe("POST /api/admin/businesses/suspend and /reactivate", () => {
    function suspendHandler() {
      return withErrorHandling("admin_business_suspend", createAdminSuspendBusinessHandler(authCtx.authService, adminCtx.adminService));
    }
    function reactivateHandler() {
      return withErrorHandling("admin_business_reactivate", createAdminReactivateBusinessHandler(authCtx.authService, adminCtx.adminService));
    }
    function postJson(url: string, sessionToken: string | undefined, body: unknown) {
      return withCookie(url, sessionToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }

    it("rejects suspend with no session (401)", async () => {
      const response = await suspendHandler()(postJson("http://localhost/api/admin/businesses/suspend", undefined, { targetBusinessId: "00000000-0000-0000-0000-000000000000", reason: "x" }));
      expect(response.status).toBe(401);
    });

    it("rejects suspend from an ordinary Member's genuine session (403)", async () => {
      const { token } = await signUpWithRole("member3@example.com", "member");
      const response = await suspendHandler()(postJson("http://localhost/api/admin/businesses/suspend", token, { targetBusinessId: "00000000-0000-0000-0000-000000000000", reason: "x" }));
      expect(response.status).toBe(403);
    });

    it("a Platform Admin with a fresh step-up can suspend then reactivate a Member-owned business end to end", async () => {
      const owner = await adminCtx.users.insert({ email: "owner2@example.com", authCredentialRef: "x", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH });
      const business = await adminCtx.businesses.insert({
        ownerUserId: owner.id,
        legalBusinessName: "Acme LLC",
        displayName: "Acme",
        entityType: "llc",
        businessAddress: null,
        country: "US",
        state: "CA",
      });
      const { token, user } = await signUpWithRole("admin4@example.com", "platform_admin");
      // Step-up is tracked against the *acting admin's own* mfa/session state, which lives on
      // adminCtx (the service the routes were built against) — the acting user's identity (id,
      // session id) is supplied by authCtx's own signup/session, matching how every other
      // admin-route test in this codebase already splits "who is authenticating" (authCtx) from
      // "what AdminService sees" (adminCtx) since AdminService trusts the session-derived
      // actingRole/actingUserId directly rather than re-resolving them from its own user repo.
      const authResult = await authCtx.authService.validateSession(token);
      const sessionId = authResult!.sessionId;
      await grantStepUp({ mfaCredentials: adminCtx.mfaCredentials, stepUps: adminCtx.stepUps }, user.id, sessionId);

      const suspendResponse = await suspendHandler()(
        postJson("http://localhost/api/admin/businesses/suspend", token, { targetBusinessId: business.id, reason: "policy" }),
      );
      expect(suspendResponse.status).toBe(200);
      expect((await adminCtx.businessDirectory.getSummary(business.id))?.status).toBe("disabled");

      await grantStepUp({ mfaCredentials: adminCtx.mfaCredentials, stepUps: adminCtx.stepUps }, user.id, sessionId);
      const reactivateResponse = await reactivateHandler()(
        postJson("http://localhost/api/admin/businesses/reactivate", token, { targetBusinessId: business.id, reason: "resolved" }),
      );
      expect(reactivateResponse.status).toBe(200);
      expect((await adminCtx.businessDirectory.getSummary(business.id))?.status).toBe("active");
    });

    it("rejects suspend without a fresh step-up, even for a genuine Platform Admin session (403)", async () => {
      const owner = await adminCtx.users.insert({ email: "owner3@example.com", authCredentialRef: "x", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH });
      const business = await adminCtx.businesses.insert({
        ownerUserId: owner.id,
        legalBusinessName: "Acme LLC",
        displayName: "Acme",
        entityType: "llc",
        businessAddress: null,
        country: "US",
        state: "CA",
      });
      const { token } = await signUpWithRole("admin5@example.com", "platform_admin");
      // Deliberately no grantStepUp call.
      const response = await suspendHandler()(
        postJson("http://localhost/api/admin/businesses/suspend", token, { targetBusinessId: business.id, reason: "policy" }),
      );
      expect(response.status).toBe(403);
    });
  });
});
