import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { NotificationService } from "@/lib/notify/notificationService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { isNotificationEventType } from "@/lib/notify/eventTypes";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setSchema = z.object({
  notificationType: z.string(),
  channel: z.enum(["email", "sms", "in_app"]),
  enabled: z.boolean(),
});

/** Always the caller's own preferences — userId is taken from the session, never accepted as a request parameter. */
export function createNotificationPreferencesGetHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const preferences = await notificationService.getPreferences(userId);
    return NextResponse.json({ preferences }, { status: 200 });
  };
}

/** "Critical notifications cannot be disabled" — NotificationService.setPreference silently no-ops an attempted opt-out of a critical type rather than erroring, so this route needs no special-case validation of its own. */
export function createNotificationPreferencesSetHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = setSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid notificationType, channel, and enabled flag are required.");
    }
    if (!isNotificationEventType(parsed.data.notificationType)) {
      throw new ValidationError("Unrecognized notificationType.");
    }
    await notificationService.setPreference({ userId, ...parsed.data, notificationType: parsed.data.notificationType });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createNotificationPreferencesGetHandler(getAuthService(), getNotificationService())(request);
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createNotificationPreferencesSetHandler(getAuthService(), getNotificationService())(request);
}

export const GET = withErrorHandling("notification_preferences_get", handleGet);
export const POST = withErrorHandling("notification_preferences_set", handlePost);
