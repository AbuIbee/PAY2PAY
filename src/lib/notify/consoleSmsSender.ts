import "server-only";
import { logger } from "@/lib/logger";
import { maskPhone } from "@/lib/phone";
import type { SmsSender } from "./smsSender";

/**
 * The pre-PRSprint-15 default: logs the message's content (structured, server-side only) instead of
 * actually delivering it. Still the correct implementation for development, test, and any deployed
 * environment that hasn't been given live Twilio credentials or has the kill switch engaged — see
 * src/lib/notify/getSmsSender.ts, which is now the single place that decides between this class and
 * TwilioSmsSender.
 */
export class ConsoleSmsSender implements SmsSender {
  async send(input: { to: string; body: string }): Promise<{ providerMessageId: string | null }> {
    logger.info("sms_send_console_only", { to: maskPhone(input.to), body: input.body });
    return { providerMessageId: null };
  }
}
