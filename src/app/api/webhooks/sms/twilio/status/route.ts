import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getServerEnv } from "@/config/env";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { NotificationService } from "@/lib/notify/notificationService";
import { parseFormUrlEncoded, verifyTwilioWebhookSignature } from "@/lib/notify/verifyTwilioWebhookSignature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Twilio MessageStatus values this route acts on. "queued"/"sending"/"sent" are acknowledged and otherwise ignored — "sent" (provider accepted) is already recorded synchronously by NotificationService.deliver() itself. */
const TERMINAL_STATUSES: Record<string, "delivered" | "failed"> = {
  delivered: "delivered",
  undelivered: "failed",
  failed: "failed",
};

/**
 * PRSprint 15, requirement #21/#22: Twilio's per-message delivery-status callback — set as the
 * `StatusCallback` on every outbound send (TwilioSmsSender), so this fires for every message this app
 * ever sends without requiring separate manual webhook configuration in the Twilio console. Same
 * signature-verification/idempotency shape as the inbound-message webhook and the Resend email
 * webhook — see those files' own doc comments.
 */
export function createSmsStatusWebhookHandler(notifications: NotificationService) {
  return async function handleStatus(request: NextRequest): Promise<Response> {
    const { TWILIO_AUTH_TOKEN, APP_URL } = getServerEnv();
    if (!TWILIO_AUTH_TOKEN) {
      throw new ConfigurationError("TWILIO_AUTH_TOKEN is not configured — cannot verify SMS provider webhooks.");
    }

    const rawBody = await request.text();
    const params = parseFormUrlEncoded(rawBody);
    const fullUrl = `${APP_URL}/api/webhooks/sms/twilio/status`;
    const verified = verifyTwilioWebhookSignature(fullUrl, params, request.headers.get("x-twilio-signature"), TWILIO_AUTH_TOKEN);
    if (!verified) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }

    const messageSid = params.MessageSid;
    const status = params.MessageStatus;
    const outcome = status ? TERMINAL_STATUSES[status] : undefined;

    if (!outcome || !messageSid) {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    const failureReason = outcome === "failed" ? `provider_status_${status}${params.ErrorCode ? `_${params.ErrorCode}` : ""}` : "";
    const updated = await notifications.recordProviderDeliveryEvent(messageSid, outcome, failureReason, new Date());
    if (!updated) {
      logger.warn("sms_webhook_unknown_provider_message_id", { status });
    }
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleStatus(request: NextRequest): Promise<Response> {
  return createSmsStatusWebhookHandler(getNotificationService())(request);
}

export const POST = withErrorHandling("sms_status_webhook", handleStatus);
