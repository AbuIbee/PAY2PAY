import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { NotificationService } from "@/lib/notify/notificationService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { SMS_CONSENT_DISCLOSURE_VERSION, SMS_CONSENT_SOURCE } from "@/lib/notify/smsConsentDisclosure";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setSchema = z.object({ enabled: z.boolean() });

/**
 * B0-B (SMS consent / A2P compliance): always the caller's own consent state — userId comes from the
 * authenticated session, never a request parameter, so there is no cross-user read/write path to
 * authorize against (mirrors every other self-scoped preference route in this codebase, e.g.
 * /api/notifications/preferences).
 */
export function createSmsConsentGetHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const status = await notificationService.getSmsConsentStatus(userId);
    return NextResponse.json(
      {
        active: status.active,
        effectiveActive: status.effectiveActive,
        phoneChangedSinceConsent: status.phoneChangedSinceConsent,
        consentedAt: status.consentedAt,
        withdrawnAt: status.withdrawnAt,
        source: status.source,
        disclosureVersion: status.disclosureVersion,
        eligibility: status.eligibility,
        currentDisclosureVersion: SMS_CONSENT_DISCLOSURE_VERSION,
      },
      { status: 200 },
    );
  };
}

/**
 * `enabled: true` requires a verified phone already on file (enforced in
 * NotificationService.activateSmsConsent, not merely by this route — "do not rely solely on hidden
 * UI," this pass's own instruction, verbatim) and always records the current disclosure version and
 * the fixed `web_form` source — never a client-supplied value for either, so a caller cannot claim a
 * disclosure version it was never actually shown.
 */
export function createSmsConsentSetHandler(authService: AuthService, notificationService: NotificationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = setSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "An 'enabled' boolean is required.");
    }
    if (parsed.data.enabled) {
      await notificationService.activateSmsConsent(userId, { source: SMS_CONSENT_SOURCE, disclosureVersion: SMS_CONSENT_DISCLOSURE_VERSION });
    } else {
      await notificationService.withdrawSmsConsent(userId, "user_disabled_in_app");
    }
    const status = await notificationService.getSmsConsentStatus(userId);
    return NextResponse.json({ active: status.active, effectiveActive: status.effectiveActive }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createSmsConsentGetHandler(getAuthService(), getNotificationService())(request);
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createSmsConsentSetHandler(getAuthService(), getNotificationService())(request);
}

export const GET = withErrorHandling("sms_consent_get", handleGet);
export const POST = withErrorHandling("sms_consent_set", handlePost);
