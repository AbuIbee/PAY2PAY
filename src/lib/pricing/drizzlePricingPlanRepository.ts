import "server-only";
import { and, asc, eq } from "drizzle-orm";
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
  async insert(input: {
    kind: PricingPlanKind;
    code: string;
    name: string;
    monthlyFeeMinorUnits: number | null;
    annualFeeMinorUnits: number | null;
    perAgreementFeeMinorUnits: number | null;
    perSuccessfulPaymentFeeMinorUnits: number | null;
    freeAgreementAllowance: number | null;
    freeIncludedPaymentsAllowance: number | null;
    isActive: boolean;
  }): Promise<PricingPlanRecord> {
    const db = getDb();
    const [row] = await db.insert(pricingPlan).values(input).returning();
    if (!row) throw new Error("pricing_plan insert returned no row");
    return toRecord(row);
  }

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

  /** "PAID2YOU PRODUCTION LAUNCH", Phase 1: ordered ascending by price so a tier picker (e.g. the onboarding Tier step) renders Starter → Core → Growth → Scale → Enterprise, never an arbitrary row order. */
  async listActiveByKind(kind: PricingPlanKind): Promise<PricingPlanRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(pricingPlan)
      .where(and(eq(pricingPlan.kind, kind), eq(pricingPlan.isActive, true)))
      .orderBy(asc(pricingPlan.monthlyFeeMinorUnits));
    return rows.map(toRecord);
  }
}
