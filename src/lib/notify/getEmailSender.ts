import "server-only";
import { getServerEnv } from "@/config/env";
import { ConsoleEmailSender } from "./consoleEmailSender";
import type { EmailSender } from "./emailSender";
import { ResendEmailSender } from "./resendEmailSender";

let cached: EmailSender | null = null;

/**
 * PRSprint 14: the single decision point for which `EmailSender` every production wiring file uses —
 * getNotificationService.ts, getAuthService.ts, getStaffService.ts, getAgreementInvitationService.ts,
 * getRelationshipInvitationService.ts. Real delivery (`ResendEmailSender`) only when a provider key
 * *and* a from-address are configured *and* the kill switch (`EMAIL_DELIVERY_ENABLED`) hasn't been
 * flipped off; otherwise falls back to `ConsoleEmailSender`, which is also what every environment
 * without a configured key already got before this PRSprint — so leaving `RESEND_API_KEY` unset is a
 * safe, fully backward-compatible default, not a degraded state. Mirrors getPaymentProvider.ts's own
 * "read config once here, pass it into the constructor" precedent — ResendEmailSender itself never
 * touches `process.env`.
 */
export function getEmailSender(): EmailSender {
  if (!cached) {
    const env = getServerEnv();
    cached =
      env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS && env.EMAIL_DELIVERY_ENABLED
        ? new ResendEmailSender({ apiKey: env.RESEND_API_KEY, fromAddress: env.EMAIL_FROM_ADDRESS, fromName: env.EMAIL_FROM_NAME })
        : new ConsoleEmailSender();
  }
  return cached;
}
