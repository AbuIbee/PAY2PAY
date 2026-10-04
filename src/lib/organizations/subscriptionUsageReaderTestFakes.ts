import type { SubscriptionUsageReader, SubscriptionUsageRecord } from "./subscriptionUsageReader";

interface StoredRow extends SubscriptionUsageRecord {
  subscriptionId: string;
}

export class InMemorySubscriptionUsageReader implements SubscriptionUsageReader {
  private rows: StoredRow[] = [];

  seed(input: { subscriptionId: string; metricKey: string; periodStart: Date; periodEnd: Date; count: number }): void {
    this.rows.push(input);
  }

  async findForPeriod(subscriptionId: string, metricKey: string, periodStart: Date): Promise<SubscriptionUsageRecord | null> {
    const row = this.rows.find((r) => r.subscriptionId === subscriptionId && r.metricKey === metricKey && r.periodStart.getTime() === periodStart.getTime());
    return row ? { metricKey: row.metricKey, periodStart: row.periodStart, periodEnd: row.periodEnd, count: row.count } : null;
  }
}
