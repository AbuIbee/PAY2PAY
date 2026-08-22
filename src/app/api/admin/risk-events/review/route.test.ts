import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestRiskEventService } from "@/lib/risk/testFakes";
import { createRiskEventsReviewHandler } from "./route";

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

function post(body: unknown, token?: string) {
  return new NextRequest("http://localhost/api/admin/risk-events/review", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/risk-events/review", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const { riskEventService } = createTestRiskEventService();
    const response = await withErrorHandling("admin_risk_events_review", createRiskEventsReviewHandler(authCtx.authService, riskEventService))(
      post({ id: randomUUID(), decision: "reviewed" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a non-admin member with 403", async () => {
    const authCtx = createTestAuthService();
    const { riskEventService } = createTestRiskEventService();
    const user = await signupAs(authCtx, "member@example.com", "member");
    const response = await withErrorHandling("admin_risk_events_review", createRiskEventsReviewHandler(authCtx.authService, riskEventService))(
      post({ id: randomUUID(), decision: "reviewed" }, user.token),
    );
    expect(response.status).toBe(403);
  });

  it("allows a platform admin to mark a signal reviewed, recording who and when", async () => {
    const authCtx = createTestAuthService();
    const { riskEventService } = createTestRiskEventService();
    const admin = await signupAs(authCtx, "admin@example.com", "platform_owner");
    const record = await riskEventService.recordSignal({ userId: "user-1", signalType: "repeated_payment_failure", severity: "low", outcome: "flagged" });

    const response = await withErrorHandling("admin_risk_events_review", createRiskEventsReviewHandler(authCtx.authService, riskEventService))(
      post({ id: record.id, decision: "reviewed" }, admin.token),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.event.reviewState).toBe("reviewed");
    expect(body.event.reviewedByUserId).toBe(admin.user.id);
  });

  it("rejects an invalid decision value", async () => {
    const authCtx = createTestAuthService();
    const { riskEventService } = createTestRiskEventService();
    const admin = await signupAs(authCtx, "admin2@example.com", "platform_owner");
    const response = await withErrorHandling("admin_risk_events_review", createRiskEventsReviewHandler(authCtx.authService, riskEventService))(
      post({ id: randomUUID(), decision: "approved" }, admin.token),
    );
    expect(response.status).toBe(400);
  });
});
