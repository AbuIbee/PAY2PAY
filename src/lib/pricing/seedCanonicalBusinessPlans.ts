import "server-only";
import type { PricingPlanEntitlementRepository } from "./pricingPlanEntitlementRepository";
import type { PricingPlanRepository } from "./pricingService";

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 1, Section 3/4/5: the production commercial
 * catalog — Starter/Core/Growth/Scale/Enterprise, stable `paid2you_business_*` codes. This REPLACES
 * the prior maximum-capacity catalog ("Core up to 25 / Growth up to 100 / Scale up to 500"): Core,
 * Growth, Scale, and Enterprise keep their exact prior prices, but now cover a VOLUME BAND one tier
 * higher than before, with a new Starter tier introduced below Core to cover the 0–24 band the old
 * catalog had no dedicated plan for (a Business with zero qualifying arrangements is still on
 * Starter, still owes the Starter fee — there is no free tier; see BUSINESS_PLAN_VOLUME_BANDS below). `new_arrangements_monthly`'s `limitValue` remains the hard
 * ceiling `arrangementUsageMetering.ts` enforces (now each band's UPPER bound, e.g. Core = 99, not
 * 25) — crossing it is the explicit, fail-closed, non-silent tier-transition signal
 * (`ArrangementUsageLimitExceededError`) Section 6 requires; this was already the correct mechanism,
 * only the catalog's numbers were calibrated to the old model. `BUSINESS_PLAN_VOLUME_BANDS` below is
 * the one place a band's lower bound is recorded (display-only — enforcement only ever needs the
 * ceiling), for any production code (the onboarding Tier step today) that needs to show a business
 * which band it falls into, not just its ceiling.
 *
 * Starter/Core/Growth/Scale deliberately share the same feature set (Section 7 of the original spec:
 * "do NOT invent different feature restrictions... primary commercial distinction is arrangement
 * volume") — the only difference between them is `new_arrangements_monthly`'s `limitValue`.
 *
 * Enterprise's `monthlyFeeMinorUnits` is the "starting $5,000/month" reference price, not a fixed
 * contractual price — a custom contractual price must be supported without pretending $5,000 is
 * always exact. This catalog row is a floor/display reference only; `subscription.
 * negotiatedMonthlyFeeMinorUnits`/`negotiatedNewArrangementsMonthlyLimit` are the per-organization
 * override columns an actual negotiated Enterprise contract uses instead (see pricing.ts's own doc
 * comments) — this seed never invents a resolution for what a specific Enterprise contract costs.
 * Enterprise's `new_arrangements_monthly` entitlement is seeded with `limitValue: null` (catalog-level
 * unlimited) for the same reason — "configurable"/"custom," never a silently-invented fixed number.
 *
 * Idempotent: re-running against a database that already has these plan codes is a no-op for those
 * rows (checked by `findByCode` before any insert) — matches this package's established pattern
 * (see LegacyRoleMigrationService's own idempotency doc comment).
 */

interface CanonicalPlanDefinition {
  code: string;
  name: string;
  monthlyFeeMinorUnits: number;
  newArrangementsMonthlyLimit: number | null;
}

const CANONICAL_BUSINESS_PLANS: readonly CanonicalPlanDefinition[] = [
  { code: "paid2you_business_starter", name: "Starter", monthlyFeeMinorUnits: 9_900, newArrangementsMonthlyLimit: 24 },
  { code: "paid2you_business_core", name: "Core", monthlyFeeMinorUnits: 19_900, newArrangementsMonthlyLimit: 99 },
  { code: "paid2you_business_growth", name: "Growth", monthlyFeeMinorUnits: 69_900, newArrangementsMonthlyLimit: 499 },
  { code: "paid2you_business_scale", name: "Scale", monthlyFeeMinorUnits: 199_900, newArrangementsMonthlyLimit: 1_999 },
  { code: "paid2you_business_enterprise", name: "Enterprise", monthlyFeeMinorUnits: 500_000, newArrangementsMonthlyLimit: null },
];

/**
 * Display-only volume-band bounds, keyed by the SAME stable plan codes as the catalog above — never
 * a second, competing source of truth for the ceiling (`newArrangementsMonthlyLimit` above, mirrored
 * onto `pricing_plan_entitlement.limit_value`, remains the one value enforcement reads). `max: null`
 * (Enterprise) means "2,000+ / custom," never a fabricated fixed ceiling.
 *
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 2: Starter's `min` is 0, not 1 — a
 * Business with ZERO qualifying arrangements in a billing period is still subscribed to Starter and
 * still owes the Starter subscription fee (volume determines the BAND a business qualifies for, not
 * whether a subscription is owed at all; there is no free tier). Every other band's `min` is the
 * first count that no longer fits the PRIOR band — unchanged.
 */
export const BUSINESS_PLAN_VOLUME_BANDS: Readonly<Record<string, { min: number; max: number | null }>> = {
  paid2you_business_starter: { min: 0, max: 24 },
  paid2you_business_core: { min: 25, max: 99 },
  paid2you_business_growth: { min: 100, max: 499 },
  paid2you_business_scale: { min: 500, max: 1_999 },
  paid2you_business_enterprise: { min: 2_000, max: null },
};

export interface SeedCanonicalBusinessPlansResult {
  created: string[];
  alreadyPresent: string[];
}

export async function seedCanonicalBusinessPlans(
  plans: PricingPlanRepository,
  entitlements: PricingPlanEntitlementRepository,
): Promise<SeedCanonicalBusinessPlansResult> {
  const created: string[] = [];
  const alreadyPresent: string[] = [];

  for (const definition of CANONICAL_BUSINESS_PLANS) {
    const existing = await plans.findByCode(definition.code);
    if (existing) {
      alreadyPresent.push(definition.code);
      continue;
    }

    const plan = await plans.insert({
      kind: "business",
      code: definition.code,
      name: definition.name,
      monthlyFeeMinorUnits: definition.monthlyFeeMinorUnits,
      annualFeeMinorUnits: null,
      perAgreementFeeMinorUnits: null,
      perSuccessfulPaymentFeeMinorUnits: null,
      freeAgreementAllowance: null,
      freeIncludedPaymentsAllowance: null,
      isActive: true,
    });

    await entitlements.insert({ pricingPlanId: plan.id, featureKey: "organization_agreements", enabled: true, limitValue: null });
    await entitlements.insert({
      pricingPlanId: plan.id,
      featureKey: "new_arrangements_monthly",
      enabled: true,
      limitValue: definition.newArrangementsMonthlyLimit,
    });

    created.push(definition.code);
  }

  return { created, alreadyPresent };
}
