import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAdminOpsServices } from "@/lib/admin/adminOpsTestFakes";
import { createEmailDeliveryListHandler } from "./route";

function getWithCookie(sessionToken?: string) {
  const headers: Record<string, string> = sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {};
  return new NextRequest("http://localhost/api/admin/notifications/email", { method: "GET", headers });
}

describe("GET /api/admin/notifications/email — unauthorized direct API access is rejected", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let adminCtx: ReturnType<typeof createTestAdminOpsServices>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    adminCtx = createTestAdminOpsServices();
  });

  function handler() {
    return withErrorHandling("admin_email_delivery_list", createEmailDeliveryListHandler(authCtx.authService, adminCtx.emailDeliveryAdminService));
  }

  it("rejects a request with no session at all (401)", async () => {
    const response = await handler()(getWithCookie());
    expect(response.status).toBe(401);
  });

  it("rejects a garbage/forged session token (401)", async () => {
    const response = await handler()(getWithCookie("not-a-real-token"));
    expect(response.status).toBe(401);
  });

  it("rejects a real, valid session belonging to an ordinary Member (403)", async () => {
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
    const response = await handler()(getWithCookie(result.token));
    expect(response.status).toBe(403);
  });

  it("rejects a Platform Admin with no internal admin role assigned (403)", async () => {
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
    expect(response.status).toBe(403);
  });

  it("accepts a Platform Owner (200)", async () => {
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    authCtx.users.setPlatformRole(result.user.id, "platform_owner");
    const response = await handler()(getWithCookie(result.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.events)).toBe(true);
  });
});
