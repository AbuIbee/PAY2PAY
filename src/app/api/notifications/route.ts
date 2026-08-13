import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { NotificationService } from "@/lib/notify/notificationService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Always the caller's own notifications — recipientUserId is taken from the session, never accepted as a request parameter, so a user can never list another user's notifications ("authorization"). */
export function createNotificationsListHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const notifications = await notificationService.listForUser(userId);
    return NextResponse.json({ notifications }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createNotificationsListHandler(getAuthService(), getNotificationService())(request);
}

export const GET = withErrorHandling("notifications_list", handleGet);
