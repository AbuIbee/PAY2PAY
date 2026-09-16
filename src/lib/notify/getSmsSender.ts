import "server-only";
import { getServerEnv } from "@/config/env";
import { ConsoleSmsSender } from "./consoleSmsSender";
import type { SmsSender } from "./smsSender";
import { TwilioSmsSender } from "./twilioSmsSender";

let cached: SmsSender | null = null;

/**
 * PRSprint 15: the single decision point for which `SmsSender` every production wiring file uses -
 * getNotificationService.ts, getMfaService.ts, getAgreementInvitationService.ts. Real delivery
 * (`TwilioSmsSender`) only when account credentials and a sender (messaging service or from-number)
 * are configured *and* the kill switch (`SMS_DELIVERY_ENABLED`) hasn't been flipped off; otherwise
 * falls back to `ConsoleSmsSender`.
 *
 * PAID2YOU - B0-D TOTAL SANDBOX ELIMINATION, requirement #9 - mirrors getEmailSender.ts's identical
 * `failClosed` precedent exactly: outside production, an unconfigured `ConsoleSmsSender` remains a
 * safe default; inside production, the same "no live Twilio config, or the kill switch is off"
 * condition constructs a `failClosed: true` `ConsoleSmsSender`, which throws instead of silently
 * logging-and-pretending-sent. This factory itself never throws - the failure surfaces only when an
 * actual send is attempted, caught and dead-lettered by NotificationService.deliver().
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
        : new ConsoleSmsSender({ failClosed: env.APP_ENV === "production" });
  }
  return cached;
}
