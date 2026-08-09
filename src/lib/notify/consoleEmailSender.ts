import "server-only";
import { logger } from "@/lib/logger";
import type { EmailSender } from "./emailSender";

/**
 * GAP, flagged deliberately: no real email provider (SendGrid/Postmark/SES/
 * Resend/etc.) is integrated anywhere in this project — notification
 * infrastructure is explicitly Sprint 17's own scope
 * (docs/sprints/SPRINT_17_Notifications.md), not Sprint 2's. This
 * implementation logs the email's content (structured, server-side only)
 * instead of actually delivering it, so the email-verification and
 * password-reset *token lifecycle* (generation, expiry, single-use) is fully
 * built and testable now, without Sprint 2 reaching into Sprint 17's scope
 * to stand up a production email transport. Swap this for a real
 * EmailSender implementation when one is wired up — no other code needs to
 * change, since callers only depend on the EmailSender interface.
 *
 * This must not be used in production for any email a user actually needs
 * to receive — tracked as an open item in docs/AUTHENTICATION.md.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(input: { to: string; subject: string; body: string }): Promise<void> {
    logger.info("email_send_console_only", {
      to: input.to,
      subject: input.subject,
      // Logged so this is usable end-to-end in development without a real
      // inbox — never do this for a provider that actually delivers mail.
      body: input.body,
    });
  }
}
