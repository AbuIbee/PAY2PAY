import "server-only";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02).
 * Kept as its own file rather than folding into pricingService.ts — that service's own doc comment
 * is explicit that it "deliberately has no method that reads, mutates, or terminates an agreement"
 * and is a deliberately small, stable surface; this entitlement-catalog read is a separate concern
 * (see src/lib/organizations/entitlementService.ts, which composes this with PricingService rather
 * than either one depending on the other).
 */
export interface PricingPlanEntitlementRecord {
  id: string;
  pricingPlanId: string;
  featureKey: string;
  enabled: boolean;
  /** NULL = unlimited/not applicable; a positive integer is an explicit cap. Never 0-for-unlimited. */
  limitValue: number | null;
}

export interface PricingPlanEntitlementRepository {
  findByPlanAndFeature(pricingPlanId: string, featureKey: string): Promise<PricingPlanEntitlementRecord | null>;
  listByPlan(pricingPlanId: string): Promise<PricingPlanEntitlementRecord[]>;
  /**
   * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), DB-5: seeds a plan's entitlement rows (e.g.
   * `new_arrangements_monthly`). Intended caller: seedCanonicalBusinessPlans.ts — never invented
   * elsewhere, matching PricingPlanRepository.insert's own doc comment.
   */
  insert(input: { pricingPlanId: string; featureKey: string; enabled: boolean; limitValue: number | null }): Promise<PricingPlanEntitlementRecord>;
}
