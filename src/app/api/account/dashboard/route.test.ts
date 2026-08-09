import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { createDashboardHandler } from "./route";

function getWithCookie(token?: string) {
  return new NextRequest("http://localhost/api/account/dashboard", {
    method: "GET",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("GET /api/account/dashboard", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;
  const email = "dashboard@example.com";

  beforeEach(async () => {
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      email,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling(
      "account_dashboard",
      createDashboardHandler(authCtx.authService, mfaCtx.mfaService),
    );
  }

  it("returns account data for an authenticated user", async () => {
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { email: string; mfaEnrolled: boolean };
    expect(body.email).toBe(email);
    expect(body.mfaEnrolled).toBe(false);
  });

  // Sprint 2 required test: "Unauthorized user cannot access protected dashboard data."
  it("rejects an unauthorized user with 401 and no account data", async () => {
    const response = await handlerFor()(getWithCookie());
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("email");
  });

  it("rejects a garbage/forged session token with 401", async () => {
    const response = await handlerFor()(getWithCookie("forged-token-not-real"));
    expect(response.status).toBe(401);
  });

  it("rejects access once the session has been revoked", async () => {
    await authCtx.authService.logout(token);
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(401);
  });
});
