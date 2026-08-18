import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getServerEnv } from "@/config/env";
import { computeSmsDeliveryStatus } from "@/lib/admin/environmentStatus";
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

/**
 * Always the caller's own preferences — userId is taken from the session, never accepted as a
 * request parameter. PRSprint 16, requirement #5/#11/#12: also returns `smsEligibility`
 * (phone-verified/masked-phone/opted-out) and `smsProviderAvailable` (the same live decision
 * `getSmsSender()` itself makes) so the UI can render an honest SMS control state instead of a plain
 * checkbox — computed fresh on every request, never a hard-coded flag, so it tracks Twilio activation
 * automatically once that External Blocker is resolved.
 */
export function createNotificationPreferencesGetHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const [preferences, smsEligibility] = await Promise.all([notificationService.getPreferences(userId), notificationService.getSmsEligibility(userId)]);
    const smsProviderAvailable = computeSmsDeliveryStatus(getServerEnv()) === "twilio";
    return NextResponse.json({ preferences, smsEligibility, smsProviderAvailable }, { status: 200 });
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
