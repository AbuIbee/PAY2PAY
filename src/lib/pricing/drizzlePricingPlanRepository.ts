import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pricingPlan } from "@/db/schema";
import type { PricingPlanKind, PricingPlanRecord, PricingPlanRepository } from "./pricingService";

type Row = typeof pricingPlan.$inferSelect;

function toRecord(row: Row): PricingPlanRecord {
  return {
    id: row.id,
    kind: row.kind,
    code: row.code,
    name: row.name,
    monthlyFeeMinorUnits: row.monthlyFeeMinorUnits,
    annualFeeMinorUnits: row.annualFeeMinorUnits,
    perAgreementFeeMinorUnits: row.perAgreementFeeMinorUnits,
    perSuccessfulPaymentFeeMinorUnits: row.perSuccessfulPaymentFeeMinorUnits,
    freeAgreementAllowance: row.freeAgreementAllowance,
    freeIncludedPaymentsAllowance: row.freeIncludedPaymentsAllowance,
    isActive: row.isActive,
    effectiveAt: row.effectiveAt,
  };
}

export class DrizzlePricingPlanRepository implements PricingPlanRepository {
  async findById(id: string): Promise<PricingPlanRecord | null> {
    const db = getDb();
    const rows = await db.select().from(pricingPlan).where(eq(pricingPlan.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findByCode(code: string): Promise<PricingPlanRecord | null> {
    const db = getDb();
    const rows = await db.select().from(pricingPlan).where(eq(pricingPlan.code, code)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listActiveByKind(kind: PricingPlanKind): Promise<PricingPlanRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(pricingPlan)
      .where(and(eq(pricingPlan.kind, kind), eq(pricingPlan.isActive, true)));
    return rows.map(toRecord);
  }
}
