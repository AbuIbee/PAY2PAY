import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestRiskEventService } from "@/lib/risk/testFakes";
import { createRiskEventsListHandler } from "./route";

async function signupAs(authCtx: ReturnType<typeof createTestAuthService>, email: string, role: "member" | "platform_admin" | "platform_owner") {
  const user = await authCtx.authService.signup({
    email,
    password: "a-strong-password",
    dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
    ipAddress: null,
    userAgent: null,
  });
  if (role !== "member") authCtx.users.setPlatformRole(user.user.id, role);
  return user;
}

describe("GET /api/admin/risk-events", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const { riskEventService } = createTestRiskEventService();
    const response = await withErrorHandling("admin_risk_events_list", createRiskEventsListHandler(authCtx.authService, riskEventService))(
      new NextRequest("http://localhost/api/admin/risk-events"),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a non-admin member with 403", async () => {
    const authCtx = createTestAuthService();
    const { riskEventService } = createTestRiskEventService();
    const user = await signupAs(authCtx, "member@example.com", "member");
    const response = await withErrorHandling("admin_risk_events_list", createRiskEventsListHandler(authCtx.authService, riskEventService))(
      new NextRequest("http://localhost/api/admin/risk-events", { headers: { cookie: `p2p_session=${user.token}` } }),
    );
    expect(response.status).toBe(403);
  });

  it("allows a platform admin to list recent risk signals, respecting the openOnly filter", async () => {
    const authCtx = createTestAuthService();
    const { riskEventService } = createTestRiskEventService();
    const admin = await signupAs(authCtx, "admin@example.com", "platform_owner");
    const flagged = await riskEventService.recordSignal({ userId: "user-1", signalType: "repeated_payment_failure", severity: "low", outcome: "flagged" });
    await riskEventService.markReviewed(admin.user.id, "platform_owner", flagged.id, admin.user.id, "dismissed");
    await riskEventService.recordSignal({ userId: "user-2", signalType: "invitation_velocity", severity: "info", outcome: "flagged" });

    const response = await withErrorHandling("admin_risk_events_list", createRiskEventsListHandler(authCtx.authService, riskEventService))(
      new NextRequest("http://localhost/api/admin/risk-events?openOnly=true", { headers: { cookie: `p2p_session=${admin.token}` } }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].signalType).toBe("invitation_velocity");
  });
});
