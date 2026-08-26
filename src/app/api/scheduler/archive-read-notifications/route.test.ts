import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createArchiveReadNotificationsHandler } from "./route";

const TEST_CRON_SECRET = "test-cron-secret-0123456789abcdef";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function postWithAuth(authHeader?: string) {
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return new NextRequest("http://localhost/api/scheduler/archive-read-notifications", { method: "POST", headers });
}

describe("POST /api/scheduler/archive-read-notifications", () => {
  let ctx: ReturnType<typeof createTestNotificationService>;

  beforeAll(() => {
    // getServerEnv() memoizes on first call — set this once, before any handler invocation, matching
    // every other scheduler route test's constraint in this codebase.
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  beforeEach(() => {
    ctx = createTestNotificationService();
  });

  function handler() {
    return withErrorHandling("scheduler_archive_read_notifications", createArchiveReadNotificationsHandler(ctx.notificationService));
  }

  it("rejects a request with no authorization header (403)", async () => {
    const response = await handler()(postWithAuth());
    expect(response.status).toBe(403);
  });

  it("rejects a request with an invalid/wrong bearer token (403)", async () => {
    const response = await handler()(postWithAuth("Bearer not-the-real-secret"));
    expect(response.status).toBe(403);
  });

  it("accepts a request with the correct bearer token (200) and reports archived: 0 when nothing is eligible", async () => {
    const response = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.archived).toBe(0);
  });

  it("archives a notification group read 7+ days ago, and leaves a recently-read one alone", async () => {
    ctx.contacts.set("user-1", "user1@example.com");
    await ctx.notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "due-for-archive" });
    const [dueGroup] = await ctx.notificationService.listCurrentGroupedForUser("user-1");
    await ctx.notificationService.markRead("user-1", dueGroup!.inAppId!);
    ctx.events.byId.get(dueGroup!.inAppId!)!.readAt = new Date(Date.now() - (SEVEN_DAYS_MS + 60_000));

    await ctx.notificationService.notify({ recipientUserId: "user-1", notificationType: "payment_cleared", payload: {}, dedupeKey: "not-due-yet" });
    // "not-due-yet" was created after "due-for-archive", so it sorts first (newest-to-oldest).
    const [notDueGroup] = await ctx.notificationService.listCurrentGroupedForUser("user-1");
    await ctx.notificationService.markRead("user-1", notDueGroup!.inAppId!);

    const response = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const body = await response.json();
    expect(body.archived).toBe(1);

    const dueAfter = [...ctx.events.byId.values()].find((r) => r.dedupeKey?.startsWith("due-for-archive:"));
    expect(dueAfter?.archivedAt).not.toBeNull();
    const notDueAfter = [...ctx.events.byId.values()].find((r) => r.dedupeKey?.startsWith("not-due-yet:"));
    expect(notDueAfter?.archivedAt).toBeNull();
  });

  it("never touches an unread notification", async () => {
    ctx.contacts.set("user-1", "user1@example.com");
    await ctx.notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "stays-unread" });

    const response = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const body = await response.json();
    expect(body.archived).toBe(0);
    const row = [...ctx.events.byId.values()].find((r) => r.dedupeKey?.startsWith("stays-unread:"));
    expect(row?.archivedAt).toBeNull();
  });

  it("is idempotent across repeated executions: a second call archives nothing further", async () => {
    ctx.contacts.set("user-1", "user1@example.com");
    await ctx.notificationService.notify({ recipientUserId: "user-1", notificationType: "agreement_signed", payload: {}, dedupeKey: "repeat-archive" });
    const [group] = await ctx.notificationService.listCurrentGroupedForUser("user-1");
    await ctx.notificationService.markRead("user-1", group!.inAppId!);
    ctx.events.byId.get(group!.inAppId!)!.readAt = new Date(Date.now() - (SEVEN_DAYS_MS + 60_000));

    const first = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const firstBody = await first.json();
    expect(firstBody.archived).toBe(1);

    const second = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const secondBody = await second.json();
    expect(secondBody.archived).toBe(0);
  });
});
