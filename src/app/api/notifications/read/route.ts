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

const readSchema = z.object({ id: z.string().uuid() });

/**
 * Sprint 18B: thin route over NotificationService.markRead. recipientUserId
 * comes only from the session, never the request body — a caller can only
 * ever mark their own notifications read.
 */
export function createNotificationsReadHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = readSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid notification id is required.");

    const updated = await notificationService.markRead(userId, parsed.data.id);
    if (!updated) throw new ValidationError("Notification not found.");
    return NextResponse.json({ notification: updated }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createNotificationsReadHandler(getAuthService(), getNotificationService())(request);
}

export const POST = withErrorHandling("notifications_mark_read", handlePost);
