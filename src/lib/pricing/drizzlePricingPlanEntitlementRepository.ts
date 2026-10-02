import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pricingPlanEntitlement } from "@/db/schema";
import type { PricingPlanEntitlementRecord, PricingPlanEntitlementRepository } from "./pricingPlanEntitlementRepository";

type Row = typeof pricingPlanEntitlement.$inferSelect;

function toRecord(row: Row): PricingPlanEntitlementRecord {
  return {
    id: row.id,
    pricingPlanId: row.pricingPlanId,
    featureKey: row.featureKey,
    enabled: row.enabled,
    limitValue: row.limitValue,
  };
}

export class DrizzlePricingPlanEntitlementRepository implements PricingPlanEntitlementRepository {
  async findByPlanAndFeature(pricingPlanId: string, featureKey: string): Promise<PricingPlanEntitlementRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(pricingPlanEntitlement)
      .where(and(eq(pricingPlanEntitlement.pricingPlanId, pricingPlanId), eq(pricingPlanEntitlement.featureKey, featureKey)))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listByPlan(pricingPlanId: string): Promise<PricingPlanEntitlementRecord[]> {
    const db = getDb();
    const rows = await db.select().from(pricingPlanEntitlement).where(eq(pricingPlanEntitlement.pricingPlanId, pricingPlanId));
    return rows.map(toRecord);
  }
}
