import "server-only";
import { logger } from "@/lib/logger";
import { EmailDeliveryError } from "./emailDeliveryError";
import type { EmailSender } from "./emailSender";
import { renderBrandedEmail, sanitizeSingleLine } from "./emailTemplateShell";

const RESEND_API_URL = "https://api.resend.com/emails";

export interface ResendEmailSenderConfig {
  apiKey: string;
  fromAddress: string;
  fromName: string;
}

/**
 * PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md): the real production email provider.
 * Resend's REST API is called directly with `fetch` — no SDK dependency, matching this codebase's
 * existing zero-dependency style for external providers (src/lib/payments,
 * src/lib/kyc — both call their sandbox providers' HTTP surface the same way rather than pulling in a
 * client library). Configuration is read once at construction time by the caller
 * (getEmailSender.ts) and passed in here, mirroring `SandboxPaymentProvider`'s identical
 * constructor-injected-secret precedent (getPaymentProvider.ts) — this class never reads
 * `process.env`/`getServerEnv()` itself, which is also what makes it straightforward to unit-test with
 * an arbitrary config instead of needing to mutate the process-wide environment.
 *
 * Never logs the API key, the raw response body, or the recipient/body together with the key. On
 * failure, classifies Resend's response into `EmailDeliveryError.retryable` so
 * `NotificationService.deliver()`'s catch block can decide whether to schedule a retry or fail
 * permanently (requirement #22 — do not retry a permanently-invalid recipient forever).
 */
export class ResendEmailSender implements EmailSender {
  constructor(private readonly config: ResendEmailSenderConfig) {}

  async send(input: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }): Promise<{ providerMessageId: string | null }> {
    const rendered = renderBrandedEmail({ subject: input.subject, body: input.body, ctaUrl: input.ctaUrl, ctaText: input.ctaText });
    const from = `${this.config.fromName} <${this.config.fromAddress}>`;

    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject: sanitizeSingleLine(input.subject),
          html: rendered.html,
          text: rendered.text,
        }),
      });
    } catch (error) {
      // Network-level failure (DNS, TLS, connection reset, fetch timeout) — always worth retrying.
      throw new EmailDeliveryError(error instanceof Error ? error.message : "email_provider_network_error", {
        retryable: true,
        category: "timeout",
      });
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { id?: string } | null;
      return { providerMessageId: body?.id ?? null };
    }

    // Never log the raw response body (may echo back request content) — only the safe metadata
    // needed to diagnose a delivery problem operationally (requirement #26/#32).
    const status = response.status;
    logger.error("email_provider_send_failed", { status, to: maskEmail(input.to) });

    if (status === 429 || status >= 500) {
      throw new EmailDeliveryError(`Resend returned ${status}`, { retryable: true, category: status === 429 ? "rate_limited" : "provider_error" });
    }
    if (status === 401 || status === 403) {
      // Not the caller's fault and retrying won't help without an operator fixing configuration —
      // still terminal for *this* send, but distinct from a bad recipient.
      throw new EmailDeliveryError(`Resend rejected the request (${status})`, { retryable: false, category: "configuration" });
    }
    // 400/404/422 and anything else in the 4xx range: treat as a permanently invalid request for
    // this specific email (e.g. malformed recipient) — retrying the identical payload would fail
    // identically every time.
    throw new EmailDeliveryError(`Resend rejected the request (${status})`, { retryable: false, category: "invalid_recipient" });
  }
}

/** Keeps an email address out of structured logs beyond what's needed to spot a pattern (domain) while diagnosing a failure — never the full address. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}
