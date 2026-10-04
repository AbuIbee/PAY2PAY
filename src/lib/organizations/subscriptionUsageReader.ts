import "server-only";

export interface SubscriptionUsageRecord {
  metricKey: string;
  periodStart: Date;
  periodEnd: Date;
  count: number;
}

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 10/13: a READ-ONLY view onto
 * `subscription_usage` for the Billing & Subscription page's usage display. Deliberately separate
 * from `arrangementUsageMetering.ts` (which owns the one WRITE path, inside a signing transaction) —
 * this interface can never increment or create a usage row, only read one.
 */
export interface SubscriptionUsageReader {
  findForPeriod(subscriptionId: string, metricKey: string, periodStart: Date): Promise<SubscriptionUsageRecord | null>;
}
