import "server-only";
import { getServerEnv } from "@/config/env";
import { ConsoleSmsSender } from "./consoleSmsSender";
import type { SmsSender } from "./smsSender";
import { TwilioSmsSender } from "./twilioSmsSender";

let cached: SmsSender | null = null;

/**
 * PRSprint 15: the single decision point for which `SmsSender` every production wiring file uses —
 * getNotificationService.ts, getMfaService.ts, getAgreementInvitationService.ts. Real delivery
 * (`TwilioSmsSender`) only when account credentials and a sender (messaging service or from-number)
 * are configured *and* the kill switch (`SMS_DELIVERY_ENABLED`) hasn't been flipped off; otherwise
 * falls back to `ConsoleSmsSender`, which is also what every environment without configured
 * credentials already got before this PRSprint — leaving Twilio unconfigured is a safe,
 * fully-backward-compatible default, not a degraded state. Mirrors getEmailSender.ts's identical
 * PRSprint 14 precedent exactly.
 */
export function getSmsSender(): SmsSender {
  if (!cached) {
    const env = getServerEnv();
    const hasSender = Boolean(env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER);
    cached =
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && hasSender && env.SMS_DELIVERY_ENABLED
        ? new TwilioSmsSender({
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID ?? null,
            fromNumber: env.TWILIO_FROM_NUMBER ?? null,
            statusCallbackUrl: `${env.APP_URL}/api/webhooks/sms/twilio/status`,
          })
        : new ConsoleSmsSender();
  }
  return cached;
}
