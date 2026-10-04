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
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt,
    providerCustomerReference: row.providerCustomerReference,
    providerSubscriptionReference: row.providerSubscriptionReference,
    negotiatedMonthlyFeeMinorUnits: row.negotiatedMonthlyFeeMinorUnits,
    negotiatedNewArrangementsMonthlyLimit: row.negotiatedNewArrangementsMonthlyLimit,
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

  async findById(id: string): Promise<SubscriptionRecord | null> {
    const db = getDb();
    const rows = await db.select().from(subscription).where(eq(subscription.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
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

  async findByProviderSubscriptionReference(providerSubscriptionReference: string): Promise<SubscriptionRecord | null> {
    const db = getDb();
    const rows = await db.select().from(subscription).where(eq(subscription.providerSubscriptionReference, providerSubscriptionReference)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findByProviderCustomerReference(providerCustomerReference: string): Promise<SubscriptionRecord | null> {
    const db = getDb();
    const rows = await db.select().from(subscription).where(eq(subscription.providerCustomerReference, providerCustomerReference)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async cancel(id: string): Promise<void> {
    const db = getDb();
    await db.update(subscription).set({ status: "canceled", endedAt: new Date() }).where(eq(subscription.id, id));
  }

  async setProviderReferences(id: string, input: { providerCustomerReference: string | null; providerSubscriptionReference: string | null }): Promise<void> {
    const db = getDb();
    await db.update(subscription).set(input).where(eq(subscription.id, id));
  }

  async setBillingPeriod(id: string, input: { currentPeriodStart: Date; currentPeriodEnd: Date }): Promise<void> {
    const db = getDb();
    await db.update(subscription).set(input).where(eq(subscription.id, id));
  }

  async requestCancelAtPeriodEnd(id: string): Promise<void> {
    const db = getDb();
    await db.update(subscription).set({ cancelAtPeriodEnd: true, canceledAt: new Date() }).where(eq(subscription.id, id));
  }

  async reactivate(id: string): Promise<void> {
    const db = getDb();
    await db.update(subscription).set({ cancelAtPeriodEnd: false, canceledAt: null }).where(eq(subscription.id, id));
  }

  async setNegotiatedTerms(
    id: string,
    input: { negotiatedMonthlyFeeMinorUnits: number | null; negotiatedNewArrangementsMonthlyLimit: number | null },
  ): Promise<void> {
    const db = getDb();
    await db.update(subscription).set(input).where(eq(subscription.id, id));
  }

  async setPricingPlan(id: string, pricingPlanId: string): Promise<void> {
    const db = getDb();
    await db.update(subscription).set({ pricingPlanId }).where(eq(subscription.id, id));
  }
}
