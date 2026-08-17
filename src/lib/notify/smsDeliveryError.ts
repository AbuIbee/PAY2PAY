/**
 * PRSprint 15, requirement #25/#39: normalized failure shape every `SmsSender` implementation can
 * throw — mirrors `EmailDeliveryError`'s identical PRSprint 14 precedent exactly, so
 * `NotificationService.deliver()`'s single catch block handles both channels with the same
 * retryable/permanent logic.
 */
export class SmsDeliveryError extends Error {
  readonly retryable: boolean;
  readonly category: "timeout" | "rate_limited" | "provider_error" | "invalid_number" | "opted_out" | "configuration" | "unknown";

  constructor(message: string, options: { retryable: boolean; category: SmsDeliveryError["category"] }) {
    super(message);
    this.name = "SmsDeliveryError";
    this.retryable = options.retryable;
    this.category = options.category;
  }
}
