import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/config/env";
import { withErrorHandling } from "@/lib/api-handler";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { NotificationService } from "@/lib/notify/notificationService";

/** Matches src/app/api/scheduler/retry-failed-payments/route.ts's identical constant-time comparison precedent. */
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
 * Sprint 17 (docs/sprints/SPRINT_17_Notifications.md): the "retry strategy" this sprint requires,
 * mirroring Sprint 13's `retry-failed-payments` route exactly — Vercel has no persistent worker
 * process, so a due retry only actually fires when a Vercel Cron Job (vercel.json) calls this route
 * with `Authorization: Bearer <CRON_SECRET>`.
 */
export function createRetryNotificationsHandler(notificationService: NotificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { CRON_SECRET } = getServerEnv();
    if (!CRON_SECRET) {
      throw new ConfigurationError("CRON_SECRET is not configured.");
    }
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${CRON_SECRET}`)) {
      throw new ForbiddenError("Invalid or missing scheduler authorization.");
    }

    const result = await notificationService.retryDueNotifications();
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createRetryNotificationsHandler(getNotificationService())(request);
}

export const POST = withErrorHandling("scheduler_retry_notifications", handlePost);
