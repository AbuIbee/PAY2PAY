import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { subscription } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { ProfileKind, SubscriptionRecord, SubscriptionRepository } from "./pricingService";

type Row = typeof subscription.$inferSelect;

function toRecord(row: Row): SubscriptionRecord {
  return {
    id: row.id,
    profileKind: row.profileKind,
    profileId: row.profileId,
    pricingPlanId: row.pricingPlanId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export class DrizzleSubscriptionRepository implements SubscriptionRepository {
  async insert(input: {
    profileKind: ProfileKind;
    profileId: string;
    pricingPlanId: string;
  }): Promise<SubscriptionRecord> {
    const db = getDb();
    const [row] = await db.insert(subscription).values(input).returning();
    if (!row) throw new ConfigurationError("subscription insert returned no row");
    return toRecord(row);
  }

  async findActiveByProfile(profileKind: ProfileKind, profileId: string): Promise<SubscriptionRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.profileKind, profileKind),
          eq(subscription.profileId, profileId),
          eq(subscription.status, "active"),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async cancel(id: string): Promise<void> {
    const db = getDb();
    await db.update(subscription).set({ status: "canceled", endedAt: new Date() }).where(eq(subscription.id, id));
  }
}
