import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { SmsDeliveryAdminService } from "@/lib/admin/smsDeliveryAdminService";
import { getSmsDeliveryAdminService } from "@/lib/admin/getSmsDeliveryAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retrySchema = z.object({ notificationEventId: z.string().uuid() });

/** Requires the "retry_sms_delivery" capability — enforced inside SmsDeliveryAdminService.retry itself. Rejects (via NotificationService.redeliverFailedEvent) any event not currently in a "failed" state, so this can never re-send an already-succeeded message. */
export function createSmsDeliveryRetryHandler(authService: AuthService, smsDeliveryAdminService: SmsDeliveryAdminService) {
  return async function handleRetry(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = retrySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid notificationEventId is required.");
    }
    const event = await smsDeliveryAdminService.retry({ notificationEventId: parsed.data.notificationEventId, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json({ event }, { status: 200 });
  };
}

async function handleRetry(request: NextRequest): Promise<Response> {
  return createSmsDeliveryRetryHandler(getAuthService(), getSmsDeliveryAdminService())(request);
}

export const POST = withErrorHandling("admin_sms_delivery_retry", handleRetry);
