import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getServerEnv } from "@/config/env";
import { ConfigurationError, ForbiddenError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import type { NotificationService } from "@/lib/notify/notificationService";
import { verifyResendWebhookSignature } from "@/lib/notify/verifyResendWebhookSignature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The subset of Resend's webhook event types this route acts on — every other type (email.sent, email.delivery_delayed, email.opened, email.clicked, ...) is acknowledged with 200 and otherwise ignored. */
const HANDLED_EVENT_TYPES: Record<string, { outcome: "delivered" | "failed"; failureReason: string }> = {
  "email.delivered": { outcome: "delivered", failureReason: "" },
  "email.bounced": { outcome: "failed", failureReason: "provider_bounced" },
  "email.complained": { outcome: "failed", failureReason: "provider_complaint" },
};

/**
 * PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md), requirement #27: unauthenticated by
 * design (Resend cannot hold a PAY2PAY session cookie) — signature verification against the raw
 * request body is the sole gate, mirroring `createPaymentWebhookHandler`'s identical Sprint 9
 * precedent exactly. Reads the body as raw text, not `request.json()`, because the signature covers
 * the exact bytes Resend signed.
 *
 * Never trusts a client/provider-supplied notification_event id — only the provider's own
 * `data.email_id`, looked up server-side via `findByProviderMessageId` (a value this app itself
 * generated and stored at send time), so a forged or replayed webhook can at most report a status for
 * a message id that was genuinely sent, never redirect a status update to an arbitrary row. Idempotent
 * by construction: re-delivering the identical event just re-applies the same status transition.
 */
export function createEmailWebhookHandler(notifications: NotificationService) {
  return async function handleWebhook(request: NextRequest): Promise<Response> {
    const { RESEND_WEBHOOK_SECRET } = getServerEnv();
    if (!RESEND_WEBHOOK_SECRET) {
      throw new ConfigurationError("RESEND_WEBHOOK_SECRET is not configured — cannot verify email provider webhooks.");
    }

    const rawBody = await request.text();
    const verified = verifyResendWebhookSignature(
      rawBody,
      {
        svixId: request.headers.get("svix-id"),
        svixTimestamp: request.headers.get("svix-timestamp"),
        svixSignature: request.headers.get("svix-signature"),
      },
      RESEND_WEBHOOK_SECRET,
    );
    if (!verified) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }

    let parsed: { type?: unknown; data?: { email_id?: unknown }; created_at?: unknown };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new ValidationError("Malformed webhook payload.");
    }

    const eventType = typeof parsed.type === "string" ? parsed.type : null;
    const emailId = typeof parsed.data?.email_id === "string" ? parsed.data.email_id : null;
    const mapped = eventType ? HANDLED_EVENT_TYPES[eventType] : undefined;

    if (!mapped || !emailId) {
      // Not a status change we track (or malformed data on an otherwise-verified event) — 200 so
      // Resend doesn't retry, no notification_event row is touched.
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    const occurredAt = typeof parsed.created_at === "string" && !Number.isNaN(Date.parse(parsed.created_at)) ? new Date(parsed.created_at) : new Date();
    const updated = await notifications.recordProviderDeliveryEvent(emailId, mapped.outcome, mapped.failureReason, occurredAt);
    if (!updated) {
      // A verified event for a message id we have no record of — safe to acknowledge and ignore
      // rather than error (nothing to update, no forgeable side effect either way).
      logger.warn("email_webhook_unknown_provider_message_id", { eventType });
    }
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleWebhook(request: NextRequest): Promise<Response> {
  return createEmailWebhookHandler(getNotificationService())(request);
}

export const POST = withErrorHandling("email_webhook", handleWebhook);
