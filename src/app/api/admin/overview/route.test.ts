import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAdminService } from "@/lib/admin/testFakes";
import { createAdminOverviewHandler } from "./route";

function getWithCookie(sessionToken?: string) {
  const headers: Record<string, string> = sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {};
  return new NextRequest("http://localhost/api/admin/overview", { method: "GET", headers });
}

describe("GET /api/admin/overview — unauthorized direct API access is rejected", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let adminCtx: ReturnType<typeof createTestAdminService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    adminCtx = createTestAdminService();
  });

  function handler() {
    return withErrorHandling("admin_overview", createAdminOverviewHandler(authCtx.authService, adminCtx.adminService));
  }

  it("rejects a request with no session at all (401)", async () => {
    const response = await handler()(getWithCookie());
    expect(response.status).toBe(401);
  });

  it("rejects a garbage/forged session token (401)", async () => {
    const response = await handler()(getWithCookie("not-a-real-token"));
    expect(response.status).toBe(401);
  });

  it("rejects a real, valid session belonging to an ordinary Member (403) — even though the session itself is genuine", async () => {
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "member@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    // Deliberately left as the default "member" role — no admin console access.
    const response = await handler()(getWithCookie(result.token));
    expect(response.status).toBe(403);
  });

  it("accepts a real session belonging to a Platform Admin (200)", async () => {
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "admin@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    authCtx.users.setPlatformRole(result.user.id, "platform_admin");
    const response = await handler()(getWithCookie(result.token));
    expect(response.status).toBe(200);
  });
});
