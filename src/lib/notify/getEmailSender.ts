import "server-only";
import { getServerEnv } from "@/config/env";
import { ConsoleEmailSender } from "./consoleEmailSender";
import type { EmailSender } from "./emailSender";
import { ResendEmailSender } from "./resendEmailSender";

let cached: EmailSender | null = null;

/**
 * PRSprint 14: the single decision point for which `EmailSender` every production wiring file uses -
 * getNotificationService.ts, getAuthService.ts, getStaffService.ts, getAgreementInvitationService.ts,
 * getRelationshipInvitationService.ts. Real delivery (`ResendEmailSender`) only when a provider key
 * *and* a from-address are configured *and* the kill switch (`EMAIL_DELIVERY_ENABLED`) hasn't been
 * flipped off; otherwise falls back to `ConsoleEmailSender`.
 *
 * PAID2YOU - B0-D TOTAL SANDBOX ELIMINATION, requirement #9 (eliminate silent fallbacks): outside
 * production, an unconfigured `ConsoleEmailSender` remains a safe, fully backward-compatible default
 * (development/test/staging convenience - never a customer-facing environment). Inside production,
 * that exact same "no live config, or the kill switch is off" condition instead constructs a
 * `failClosed: true` `ConsoleEmailSender`, which throws instead of silently logging-and-pretending-sent
 * - see that class's own doc comment. This factory itself deliberately never throws (unlike
 * getPaymentProvider.ts's `ProviderNotAvailableError`): a misconfigured/paused email provider must not
 * take down every unrelated route that happens to also send a notification as a side effect. The
 * failure surfaces only when an actual send is attempted, and is caught and dead-lettered by
 * NotificationService.deliver() exactly like any other permanent provider failure.
 */
export function getEmailSender(): EmailSender {
  if (!cached) {
    const env = getServerEnv();
    cached =
      env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS && env.EMAIL_DELIVERY_ENABLED
        ? new ResendEmailSender({ apiKey: env.RESEND_API_KEY, fromAddress: env.EMAIL_FROM_ADDRESS, fromName: env.EMAIL_FROM_NAME })
        : new ConsoleEmailSender({ failClosed: env.APP_ENV === "production" });
  }
  return cached;
}
