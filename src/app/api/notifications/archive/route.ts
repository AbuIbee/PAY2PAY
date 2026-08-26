import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { NotificationService } from "@/lib/notify/notificationService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `id` here is a GroupedNotification.groupId — usually a dedupeKey prefix (an arbitrary caller-chosen
// string, not necessarily a UUID) — so this deliberately doesn't require UUID shape, unlike
// /api/notifications/read's `id` (a real notification_event row id).
const archiveSchema = z.object({ id: z.string().min(1).max(500) });

/**
 * Production follow-up (Notification archive): thin route over
 * NotificationService.archiveNotification. recipientUserId comes only from the session, never the
 * request body — a caller can only ever archive their own notifications. Archiving a stale/foreign/
 * already-archived groupId is a safe no-op (200, archived: false), not an error — the UI never needs
 * to distinguish "nothing to do" from a real failure for what is, from the user's perspective, always
 * a harmless idempotent action.
 */
export function createNotificationsArchiveHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = archiveSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid notification id is required.");

    const archived = await notificationService.archiveNotification(userId, parsed.data.id);
    return NextResponse.json({ archived }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createNotificationsArchiveHandler(getAuthService(), getNotificationService())(request);
}

export const POST = withErrorHandling("notifications_archive", handlePost);
