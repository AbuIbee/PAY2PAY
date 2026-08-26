import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createNotificationsArchiveAllHandler } from "./route";

function postWithCookie(sessionToken?: string) {
  const headers: Record<string, string> = sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {};
  return new NextRequest("http://localhost/api/notifications/archive-all", { method: "POST", headers });
}

describe("POST /api/notifications/archive-all", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let notifyCtx: ReturnType<typeof createTestNotificationService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    notifyCtx = createTestNotificationService();
  });

  function handler() {
    return withErrorHandling("notifications_archive_all", createNotificationsArchiveAllHandler(authCtx.authService, notifyCtx.notificationService));
  }

  it("rejects a request with no session (401)", async () => {
    const response = await handler()(postWithCookie());
    expect(response.status).toBe(401);
  });

  it("archives every read, non-action-required notification, leaves action-required and unread ones in Current", async () => {
    const user = await authCtx.authService.signup({
      email: "archive-all@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    notifyCtx.contacts.set(user.user.id, "archive-all@example.com");

    // Read, informational — sweepable.
    await notifyCtx.notificationService.notify({ recipientUserId: user.user.id, notificationType: "agreement_signed", payload: {}, dedupeKey: "aa-read" });
    const [readGroup] = await notifyCtx.notificationService.listCurrentGroupedForUser(user.user.id);
    await notifyCtx.notificationService.markRead(user.user.id, readGroup!.inAppId!);

    // Unread, informational — not sweepable (still unread).
    await notifyCtx.notificationService.notify({ recipientUserId: user.user.id, notificationType: "payment_cleared", payload: {}, dedupeKey: "aa-unread" });

    // Action-required, even though read — never sweepable.
    await notifyCtx.notificationService.notify({ recipientUserId: user.user.id, notificationType: "amendment", payload: {}, dedupeKey: "aa-action" });
    const groupsBeforeRead = await notifyCtx.notificationService.listCurrentGroupedForUser(user.user.id);
    const actionGroup = groupsBeforeRead.find((g) => g.groupId === "aa-action")!;
    await notifyCtx.notificationService.markRead(user.user.id, actionGroup.inAppId!);

    const response = await handler()(postWithCookie(user.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archived).toBe(1);

    const current = await notifyCtx.notificationService.listCurrentGroupedForUser(user.user.id);
    expect(current.map((g) => g.groupId).sort()).toEqual(["aa-action", "aa-unread"]);

    const archived = await notifyCtx.notificationService.listArchivedGroupedForUser(user.user.id);
    expect(archived.map((g) => g.groupId)).toEqual(["aa-read"]);
  });

  it("reports archived: 0 when nothing is sweepable", async () => {
    const user = await authCtx.authService.signup({
      email: "archive-all-none@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(postWithCookie(user.token));
    const body = await response.json();
    expect(body.archived).toBe(0);
  });
});
