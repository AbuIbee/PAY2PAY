import "server-only";
import { logger } from "@/lib/logger";
import { EmailDeliveryError } from "./emailDeliveryError";
import type { EmailSender } from "./emailSender";

/**
 * The pre-PRSprint-14 default: logs the email's content (structured, server-side only) instead of
 * actually delivering it. Still the correct implementation for development, test, and any deployed
 * environment that hasn't been given a live provider key or has the kill switch engaged — see
 * src/lib/notify/getEmailSender.ts, which is now the single place that decides between this class and
 * ResendEmailSender. No other code should construct this class directly outside that factory (or a
 * test) — callers depend on the `EmailSender` interface, never this concrete type.
 *
 * Sandbox-elimination fail-closed protection: `getEmailSender.ts` passes `failClosed: true` whenever
 * `APP_ENV === "production"` and no live Resend configuration is available — this class then refuses to
 * log-and-pretend-sent, and throws instead. The throw is a normal `EmailDeliveryError` (non-retryable,
 * "configuration" category), so `NotificationService.deliver()`'s existing catch block dead-letters the
 * notification exactly the way any other permanent provider failure is handled, never a silently
 * "successful" console log standing in for a real send in production.
 */
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly options: { failClosed?: boolean } = {}) {}

  async send(input: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }): Promise<{ providerMessageId: string | null }> {
    if (this.options.failClosed) {
      throw new EmailDeliveryError(
        "Production email delivery is not configured (no live provider key, or the delivery kill switch is engaged) — refusing to silently log instead of sending.",
        { retryable: false, category: "configuration" },
      );
    }
    logger.info("email_send_console_only", {
      to: input.to,
      subject: input.subject,
      // Logged so this is usable end-to-end in development without a real
      // inbox — never do this for a provider that actually delivers mail.
      body: input.body,
      ctaUrl: input.ctaUrl ?? null,
    });
    return { providerMessageId: null };
  }
}
