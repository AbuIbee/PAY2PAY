import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAdminOpsServices } from "@/lib/admin/adminOpsTestFakes";
import { createSmsDeliveryRetryHandler } from "./route";

function postWithCookie(body: unknown, sessionToken?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken) headers.cookie = `p2p_session=${sessionToken}`;
  return new NextRequest("http://localhost/api/admin/notifications/sms/retry", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /api/admin/notifications/sms/retry — unauthorized direct API access is rejected", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let adminCtx: ReturnType<typeof createTestAdminOpsServices>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    adminCtx = createTestAdminOpsServices();
  });

  function handler() {
    return withErrorHandling("admin_sms_delivery_retry", createSmsDeliveryRetryHandler(authCtx.authService, adminCtx.smsDeliveryAdminService));
  }

  it("rejects a request with no session at all (401)", async () => {
    const response = await handler()(postWithCookie({ notificationEventId: "00000000-0000-0000-0000-000000000000" }));
    expect(response.status).toBe(401);
  });

  it("rejects an ordinary Member (403) even with a well-formed body", async () => {
    const result = await authCtx.authService.signup({
      email: "member@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(postWithCookie({ notificationEventId: "00000000-0000-0000-0000-000000000000" }, result.token));
    expect(response.status).toBe(403);
  });

  it("rejects a malformed body (400) even for a Platform Owner", async () => {
    const result = await authCtx.authService.signup({
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    authCtx.users.setPlatformRole(result.user.id, "platform_owner");
    const response = await handler()(postWithCookie({ notificationEventId: "not-a-uuid" }, result.token));
    expect(response.status).toBe(400);
  });

  it("a Platform Owner can retry a genuinely failed SMS event (200)", async () => {
    const result = await authCtx.authService.signup({
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    authCtx.users.setPlatformRole(result.user.id, "platform_owner");

    adminCtx.notifyCtx.contacts.setPhone("user-1", "+15551234567");
    adminCtx.notifyCtx.smsSender.failNext = true;
    const records = await adminCtx.notifyCtx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_failed", payload: {} });
    const record = records.find((r) => r.channel === "sms")!;

    const response = await handler()(postWithCookie({ notificationEventId: record.id }, result.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.event.status).toBe("sent");
  });
});
