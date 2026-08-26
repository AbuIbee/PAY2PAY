import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { NotificationService } from "@/lib/notify/notificationService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Production follow-up (Notification archive): "Archive all read/completed" bulk action — thin route
 * over NotificationService.archiveAllReadOrCompleted, which itself decides exactly what qualifies (see
 * that method's own doc comment: never action-required, and already read or nothing to read).
 * recipientUserId comes only from the session — a caller can only ever bulk-archive their own
 * notifications. No request body; this always acts on the caller's own current Current-tab
 * notifications, nothing else to parameterize.
 */
export function createNotificationsArchiveAllHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const result = await notificationService.archiveAllReadOrCompleted(userId);
    return NextResponse.json(result, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createNotificationsArchiveAllHandler(getAuthService(), getNotificationService())(request);
}

export const POST = withErrorHandling("notifications_archive_all", handlePost);
