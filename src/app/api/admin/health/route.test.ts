import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createAdminHealthHandler } from "./route";

describe("GET /api/admin/health", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const response = await withErrorHandling("admin_health_check", createAdminHealthHandler(authCtx.authService))(
      new NextRequest("http://localhost/api/admin/health"),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a non-admin user with 403", async () => {
    const authCtx = createTestAuthService();
    const user = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `not-admin-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await withErrorHandling("admin_health_check", createAdminHealthHandler(authCtx.authService))(
      new NextRequest("http://localhost/api/admin/health", { headers: { cookie: `p2p_session=${user.token}` } }),
    );
    expect(response.status).toBe(403);
  });
});
