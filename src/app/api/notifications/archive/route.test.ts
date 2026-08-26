import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createNotificationsArchiveHandler } from "./route";

function postWithCookie(body: unknown, sessionToken?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken) headers.cookie = `p2p_session=${sessionToken}`;
  return new NextRequest("http://localhost/api/notifications/archive", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /api/notifications/archive", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    notifyCtx = createTestNotificationService();
  });

  function handler() {
    return withErrorHandling("notifications_archive", createNotificationsArchiveHandler(authCtx.authService, notifyCtx.notificationService));
  }

  it("rejects a request with no session (401)", async () => {
    const response = await handler()(postWithCookie({ id: "some-group" }));
    expect(response.status).toBe(401);
  });

  it("rejects a request missing id (400)", async () => {
    const user = await authCtx.authService.signup({
      email: "archive-missing-id@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(postWithCookie({}, user.token));
    expect(response.status).toBe(400);
  });

  it("archives a real notification belonging to the caller (archived: true)", async () => {
    const user = await authCtx.authService.signup({
      email: "archive-owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    notifyCtx.contacts.set(user.user.id, "archive-owner@example.com");
    await notifyCtx.notificationService.notify({ recipientUserId: user.user.id, notificationType: "agreement_signed", payload: {}, dedupeKey: "ar-1" });

    const response = await handler()(postWithCookie({ id: "ar-1" }, user.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archived).toBe(true);

    const current = await notifyCtx.notificationService.listCurrentGroupedForUser(user.user.id);
    expect(current).toHaveLength(0);
    const archived = await notifyCtx.notificationService.listArchivedGroupedForUser(user.user.id);
    expect(archived).toHaveLength(1);
  });

  it("never archives another user's notification — cross-tenant groupId is a safe no-op (archived: false), not an error", async () => {
    const owner = await authCtx.authService.signup({
      email: "archive-real-owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "archive-stranger@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    notifyCtx.contacts.set(owner.user.id, "archive-real-owner@example.com");
    await notifyCtx.notificationService.notify({ recipientUserId: owner.user.id, notificationType: "agreement_signed", payload: {}, dedupeKey: "ar-2" });

    const response = await handler()(postWithCookie({ id: "ar-2" }, stranger.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archived).toBe(false);

    const ownerCurrent = await notifyCtx.notificationService.listCurrentGroupedForUser(owner.user.id);
    expect(ownerCurrent).toHaveLength(1); // untouched — the stranger's request had no effect
  });

  it("a stale/unknown groupId is a safe no-op (archived: false)", async () => {
    const user = await authCtx.authService.signup({
      email: "archive-unknown@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(postWithCookie({ id: "does-not-exist" }, user.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archived).toBe(false);
  });
});
