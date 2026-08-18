import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createNotificationsListHandler } from "./route";

function getWithCookie(sessionToken?: string) {
  const headers: Record<string, string> = sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {};
  return new NextRequest("http://localhost/api/notifications", { method: "GET", headers });
}

describe("GET /api/notifications", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    notifyCtx = createTestNotificationService();
  });

  function handler() {
    return withErrorHandling("notifications_list", createNotificationsListHandler(authCtx.authService, notifyCtx.notificationService));
  }

  it("rejects a request with no session at all (401)", async () => {
    const response = await handler()(getWithCookie());
    expect(response.status).toBe(401);
  });

  it("rejects a garbage/forged session token (401)", async () => {
    const response = await handler()(getWithCookie("not-a-real-token"));
    expect(response.status).toBe(401);
  });

  it("returns only the authenticated user's own notifications, never another user's, and in the grouped shape (not raw rows)", async () => {
    const userA = await authCtx.authService.signup({
      email: "usera@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const userB = await authCtx.authService.signup({
      email: "userb@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });

    notifyCtx.contacts.set(userA.user.id, "usera@example.com");
    notifyCtx.contacts.set(userB.user.id, "userb@example.com");
    await notifyCtx.notificationService.notify({ recipientUserId: userA.user.id, notificationType: "agreement_signed", payload: {}, dedupeKey: "a1" });
    await notifyCtx.notificationService.notify({ recipientUserId: userB.user.id, notificationType: "agreement_signed", payload: {}, dedupeKey: "b1" });

    const response = await handler()(getWithCookie(userA.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notifications).toHaveLength(1);
    // Grouped shape — channels array, not a raw per-channel row.
    expect(Array.isArray(body.notifications[0].channels)).toBe(true);
    expect(body.notifications[0].groupId).toBeDefined();
  });
});
