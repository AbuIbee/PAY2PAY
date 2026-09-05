import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/config/env";
import { withErrorHandling } from "@/lib/api-handler";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { NotificationService } from "@/lib/notify/notificationService";

/** Matches src/app/api/scheduler/retry-notifications/route.ts's identical constant-time comparison precedent. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Agreement page ordering + notification retention (mandatory command): the durability sweep for the
 * 7-day read-to-archive rule. `NotificationService.listCurrentGroupedForUser`/`listArchivedGroupedForUser`
 * already make the *view* correct on every read regardless of this route ever running — this route
 * exists only so the archived state becomes real (`archived_at` actually persisted), and so the rule
 * "functions reliably even if the user does not keep the Notifications page open" rather than depending
 * on a browser timer. A Vercel Cron Job (vercel.json) calls this route with
 * `Authorization: Bearer <CRON_SECRET>`, mirroring every other scheduler route in this codebase.
 */
export function createArchiveReadNotificationsHandler(notificationService: NotificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { CRON_SECRET } = getServerEnv();
    if (!CRON_SECRET) {
      throw new ConfigurationError("CRON_SECRET is not configured.");
    }
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${CRON_SECRET}`)) {
      throw new ForbiddenError("Invalid or missing scheduler authorization.");
    }

    const result = await notificationService.autoArchiveEligibleReadNotifications();
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createArchiveReadNotificationsHandler(getNotificationService())(request);
}

export const POST = withErrorHandling("scheduler_archive_read_notifications", handlePost);
// Vercel Cron invokes the configured path with HTTP GET (see vercel.json); POST is kept for
// backward compatibility. Same handler reference for both — no duplicated business logic, and the
// CRON_SECRET check inside handlePost runs identically regardless of which verb reached it.
export const GET = POST;
