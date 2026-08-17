/**
 * PRSprint 14, requirement #22/#26: a normalized failure shape every `EmailSender` implementation can
 * throw, so `NotificationService.deliver()`'s single catch block can tell a transient provider failure
 * (worth the existing bounded-retry/backoff treatment) apart from a permanent one (retrying it would
 * just waste attempts and delay the terminal/dead-lettered state) without knowing anything about the
 * specific provider's own response shape.
 */
export class EmailDeliveryError extends Error {
  readonly retryable: boolean;
  /** Coarse, safe-to-log category — never the provider's raw response body (requirement #26/#32). */
  readonly category: "timeout" | "rate_limited" | "provider_error" | "invalid_recipient" | "configuration" | "unknown";

  constructor(message: string, options: { retryable: boolean; category: EmailDeliveryError["category"] }) {
    super(message);
    this.name = "EmailDeliveryError";
    this.retryable = options.retryable;
    this.category = options.category;
  }
}
