import "server-only";
import { logger } from "@/lib/logger";
import { maskPhone } from "@/lib/phone";
import { SmsDeliveryError } from "./smsDeliveryError";
import type { SmsSender } from "./smsSender";

/**
 * The pre-PRSprint-15 default: logs the message's content (structured, server-side only) instead of
 * actually delivering it. Still the correct implementation for development, test, and any deployed
 * environment that hasn't been given live Twilio credentials or has the kill switch engaged — see
 * src/lib/notify/getSmsSender.ts, which is now the single place that decides between this class and
 * TwilioSmsSender.
 *
 * Sandbox-elimination fail-closed protection: mirrors ConsoleEmailSender's identical `failClosed`
 * precedent exactly — `getSmsSender.ts` passes `failClosed: true` whenever `APP_ENV === "production"`
 * and no live Twilio configuration is available, and this class then throws an `SmsDeliveryError`
 * instead of silently logging a "sent" SMS that was never actually delivered.
 */
export class ConsoleSmsSender implements SmsSender {
  constructor(private readonly options: { failClosed?: boolean } = {}) {}

  async send(input: { to: string; body: string }): Promise<{ providerMessageId: string | null }> {
    if (this.options.failClosed) {
      throw new SmsDeliveryError(
        "Production SMS delivery is not configured (no live Twilio credentials, or the delivery kill switch is engaged) — refusing to silently log instead of sending.",
        { retryable: false, category: "configuration" },
      );
    }
    logger.info("sms_send_console_only", { to: maskPhone(input.to), body: input.body });
    return { providerMessageId: null };
  }
}
