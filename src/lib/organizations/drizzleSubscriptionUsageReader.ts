import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { subscriptionUsage } from "@/db/schema";
import type { SubscriptionUsageReader, SubscriptionUsageRecord } from "./subscriptionUsageReader";

export class DrizzleSubscriptionUsageReader implements SubscriptionUsageReader {
  async findForPeriod(subscriptionId: string, metricKey: string, periodStart: Date): Promise<SubscriptionUsageRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptionUsage)
      .where(and(eq(subscriptionUsage.subscriptionId, subscriptionId), eq(subscriptionUsage.metricKey, metricKey), eq(subscriptionUsage.periodStart, periodStart)))
      .limit(1);
    const row = rows[0];
    return row ? { metricKey: row.metricKey, periodStart: row.periodStart, periodEnd: row.periodEnd, count: row.count } : null;
  }
}
