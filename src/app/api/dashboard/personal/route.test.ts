import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createPersonalDashboardHandler } from "./route";

function getWithCookie(token?: string) {
  return new NextRequest("http://localhost/api/dashboard/personal", {
    method: "GET",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("GET /api/dashboard/personal", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    const result = await authCtx.authService.signup({
      email: "dash-personal@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling("dashboard_personal", createPersonalDashboardHandler(authCtx.authService));
  }

  it("returns real empty-state data, not fabricated numbers", async () => {
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      moneyIOweMinorUnits: 0,
      moneyOwedToMeMinorUnits: 0,
      agreements: [],
      upcomingPayments: [],
      requests: [],
    });
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie());
    expect(response.status).toBe(401);
  });
});
