import "server-only";
import { logger } from "@/lib/logger";
import { maskPhone } from "@/lib/phone";
import { SmsDeliveryError } from "./smsDeliveryError";
import type { SmsSender } from "./smsSender";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface TwilioSmsSenderConfig {
  accountSid: string;
  authToken: string;
  /** Preferred over `fromNumber` when both are set — Twilio's own recommended production pattern (A2P 10DLC sender-pool/number rotation is handled transparently). */
  messagingServiceSid: string | null;
  fromNumber: string | null;
  /** Absolute URL Twilio should POST delivery-status callbacks to for every message this sender sends — built from the trusted, centralized APP_URL, never a per-request value. */
  statusCallbackUrl: string;
}

/**
 * PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md): the real production SMS provider.
 * Twilio's REST API is called directly with `fetch` — no SDK dependency, mirroring
 * `ResendEmailSender`'s identical PRSprint 14 precedent. Configuration is read once by the caller
 * (getSmsSender.ts) and injected via the constructor — this class never reads `process.env` itself.
 *
 * Never logs the auth token or the raw provider response body. On failure, classifies Twilio's
 * response into `SmsDeliveryError.retryable` so `NotificationService.deliver()`'s catch block can
 * decide whether to schedule a retry or fail permanently.
 */
export class TwilioSmsSender implements SmsSender {
  constructor(private readonly config: TwilioSmsSenderConfig) {}

  async send(input: { to: string; body: string }): Promise<{ providerMessageId: string | null }> {
    if (!this.config.messagingServiceSid && !this.config.fromNumber) {
      throw new SmsDeliveryError("Neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_FROM_NUMBER is configured.", {
        retryable: false,
        category: "configuration",
      });
    }

    const body = new URLSearchParams();
    body.set("To", input.to);
    body.set("Body", input.body);
    body.set("StatusCallback", this.config.statusCallbackUrl);
    if (this.config.messagingServiceSid) {
      body.set("MessagingServiceSid", this.config.messagingServiceSid);
    } else if (this.config.fromNumber) {
      body.set("From", this.config.fromNumber);
    }

    const basicAuth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");

    let response: Response;
    try {
      response = await fetch(`${TWILIO_API_BASE}/Accounts/${this.config.accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (error) {
      throw new SmsDeliveryError(error instanceof Error ? error.message : "sms_provider_network_error", {
        retryable: true,
        category: "timeout",
      });
    }

    if (response.ok) {
      const parsed = (await response.json().catch(() => null)) as { sid?: string } | null;
      return { providerMessageId: parsed?.sid ?? null };
    }

    const status = response.status;
    const errorBody = (await response.json().catch(() => null)) as { code?: number } | null;
    // Never log the raw response body beyond Twilio's own numeric error code (requirement #37) —
    // never the recipient's full number, never anything resembling message content.
    logger.error("sms_provider_send_failed", { status, twilioErrorCode: errorBody?.code ?? null, to: maskPhone(input.to) });

    if (status === 429 || status >= 500) {
      throw new SmsDeliveryError(`Twilio returned ${status}`, { retryable: true, category: status === 429 ? "rate_limited" : "provider_error" });
    }
    if (status === 401 || status === 403) {
      throw new SmsDeliveryError(`Twilio rejected the request (${status})`, { retryable: false, category: "configuration" });
    }
    // Twilio error code 21610 = "message filtered" / recipient unsubscribed via STOP; 21211/21614 =
    // invalid/unreachable number — all permanent for this specific destination.
    if (errorBody?.code === 21610) {
      throw new SmsDeliveryError("Recipient has opted out (Twilio 21610).", { retryable: false, category: "opted_out" });
    }
    throw new SmsDeliveryError(`Twilio rejected the request (${status})`, { retryable: false, category: "invalid_number" });
  }
}
