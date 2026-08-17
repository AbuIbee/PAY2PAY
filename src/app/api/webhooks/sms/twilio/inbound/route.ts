import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getServerEnv } from "@/config/env";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { NotificationService } from "@/lib/notify/notificationService";
import { parseFormUrlEncoded, verifyTwilioWebhookSignature } from "@/lib/notify/verifyTwilioWebhookSignature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
// Recognized but not acted on beyond acknowledging (Twilio's own carrier-level Advanced Opt-Out
// already handles the standard reply text for these on a properly configured number) — requirement
// #23 explicitly scopes this to "only the compliance-critical inbound handling," not a general
// conversational surface.
const HELP_KEYWORDS = new Set(["help", "info"]);

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

/**
 * PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #23/#24: inbound-message
 * webhook — Twilio POSTs every message received on the configured number/messaging service here.
 * Only STOP-family keywords are acted on (recorded via `NotificationService.recordSmsOptOut`, which
 * only this route ever calls); everything else — including HELP, and any free-text reply — is
 * acknowledged with empty TwiML and otherwise ignored. This is not a conversational SMS surface
 * (requirement #23's own "do not build a general conversational SMS product").
 *
 * Unauthenticated by design (Twilio cannot hold a PAY2PAY session cookie) — signature verification
 * against the exact webhook URL is the sole gate, mirroring the Resend webhook's identical PRSprint 14
 * precedent. Idempotent: recording the same opt-out twice is a no-op upsert
 * (DrizzleSmsOptOutRepository.recordOptOut), never a duplicate row or an error.
 */
export function createSmsInboundWebhookHandler(notifications: NotificationService) {
  return async function handleInbound(request: NextRequest): Promise<Response> {
    const { TWILIO_AUTH_TOKEN, APP_URL } = getServerEnv();
    if (!TWILIO_AUTH_TOKEN) {
      throw new ConfigurationError("TWILIO_AUTH_TOKEN is not configured — cannot verify SMS provider webhooks.");
    }

    const rawBody = await request.text();
    const params = parseFormUrlEncoded(rawBody);
    const fullUrl = `${APP_URL}/api/webhooks/sms/twilio/inbound`;
    const verified = verifyTwilioWebhookSignature(fullUrl, params, request.headers.get("x-twilio-signature"), TWILIO_AUTH_TOKEN);
    if (!verified) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }

    const from = params.From;
    const body = (params.Body ?? "").trim().toLowerCase();

    if (from && STOP_KEYWORDS.has(body)) {
      await notifications.recordSmsOptOut(from);
    }
    // HELP and anything else: acknowledged, not acted on further — see this file's own doc comment.
    void HELP_KEYWORDS.has(body);

    return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } });
  };
}

async function handleInbound(request: NextRequest): Promise<Response> {
  return createSmsInboundWebhookHandler(getNotificationService())(request);
}

export const POST = withErrorHandling("sms_inbound_webhook", handleInbound);
