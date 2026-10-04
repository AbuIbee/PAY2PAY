/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 16: the customer-visible subscription
 * status model. `subscription.status` itself is only ever "active" | "canceled" (src/db/schema/
 * enums.ts's `subscription_status` enum) — this derives the richer, honest customer-facing label from
 * that plus the other domain facts that already exist, never inventing a new DB column/enum value.
 *
 * PAYMENT_FAILED is deliberately NOT one of the derived labels: there is no domain signal
 * distinguishing "a charge attempt failed" from "an invoice is past due" anywhere in this codebase
 * today (`subscription_invoice_status` has no `payment_failed` value) — inventing a 6th bucket with no
 * backing signal would violate "use the repository's exact enums where they differ." PAST_DUE is the
 * one that actually exists and is used instead.
 */
export type SubscriptionDisplayStatus = "ACTIVE" | "PAST_DUE" | "CANCEL_AT_PERIOD_END" | "CANCELED" | "SUSPENDED" | "NOT_SUBSCRIBED";

export function deriveSubscriptionDisplayStatus(input: {
  organizationStatus: "active" | "disabled" | "deleted";
  subscription: { status: "active" | "canceled"; cancelAtPeriodEnd: boolean } | null;
  hasPastDueInvoice: boolean;
}): SubscriptionDisplayStatus {
  if (input.organizationStatus !== "active") return "SUSPENDED";
  if (!input.subscription) return "NOT_SUBSCRIBED";
  if (input.subscription.status === "canceled") return "CANCELED";
  if (input.subscription.cancelAtPeriodEnd) return "CANCEL_AT_PERIOD_END";
  if (input.hasPastDueInvoice) return "PAST_DUE";
  return "ACTIVE";
}
