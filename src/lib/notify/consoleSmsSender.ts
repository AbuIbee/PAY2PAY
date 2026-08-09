import "server-only";
import { logger } from "@/lib/logger";
import type { SmsSender } from "./smsSender";

/**
 * Same gap and rationale as ConsoleEmailSender (see that file's doc
 * comment) — no SMS provider (Twilio/etc.) is integrated; this logs instead
 * of delivering, so the SMS-fallback MFA code lifecycle is fully built and
 * testable without Sprint 2 standing up a production SMS transport. Must
 * not be used in production — tracked as an open item in docs/AUTHENTICATION.md.
 */
export class ConsoleSmsSender implements SmsSender {
  async send(input: { to: string; body: string }): Promise<void> {
    logger.info("sms_send_console_only", { to: input.to, body: input.body });
  }
}
