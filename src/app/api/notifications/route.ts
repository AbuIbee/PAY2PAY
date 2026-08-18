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
 * Always the caller's own notifications — recipientUserId is taken from the session, never accepted
 * as a request parameter, so a user can never list another user's notifications ("authorization").
 *
 * PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md), requirement
 * #18/#21: returns `listGroupedForUser` (one entry per logical notification, with a `channels` array)
 * instead of the raw one-row-per-channel `notification_event` rows `listForUser` returns — a critical
 * type still fans out to 2-3 rows internally (email/sms/in_app), which previously rendered as 2-3
 * near-identical cards for what a user experiences as a single notification.
 */
export function createNotificationsListHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const notifications = await notificationService.listGroupedForUser(userId);
    return NextResponse.json({ notifications }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createNotificationsListHandler(getAuthService(), getNotificationService())(request);
}

export const GET = withErrorHandling("notifications_list", handleGet);
