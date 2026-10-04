import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { DrizzlePricingPlanEntitlementRepository } from "@/lib/pricing/drizzlePricingPlanEntitlementRepository";
import { getPricingService } from "@/lib/pricing/getPricingService";
import type { PricingPlanEntitlementRepository } from "@/lib/pricing/pricingPlanEntitlementRepository";
import type { PricingService } from "@/lib/pricing/pricingService";
import { BUSINESS_PLAN_VOLUME_BANDS } from "@/lib/pricing/seedCanonicalBusinessPlans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Section 4: the Tier Selection step's own read of the canonical Business plan catalog
 * (seedCanonicalBusinessPlans.ts remains the one place prices/codes are authored — this route never
 * hard-codes a second, conflicting commercial catalog). Authenticated-only, not membership-scoped:
 * the catalog itself is not organization-specific, so any signed-in user may read it (same "what can
 * I subscribe to" read any prospective Business owner needs before an organization even exists yet).
 */
export function createOnboardingPlansGetHandler(
  authService: AuthService,
  pricing: PricingService,
  entitlements: PricingPlanEntitlementRepository,
) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    await requireSession(request, authService);
    const plans = await pricing.listPlans("business");
    const withLimits = await Promise.all(
      plans.map(async (plan) => {
        const entitlement = await entitlements.findByPlanAndFeature(plan.id, "new_arrangements_monthly");
        return {
          code: plan.code,
          name: plan.name,
          monthlyFeeMinorUnits: plan.monthlyFeeMinorUnits,
          /** NULL = unlimited/custom (Enterprise) — never a fabricated fixed number. */
          newArrangementsMonthlyLimit: entitlement?.limitValue ?? null,
          /**
           * "PAID2YOU PRODUCTION LAUNCH", Phase 1, Section 5: the band's lower bound, display-only —
           * `newArrangementsMonthlyLimit` above (the upper bound) remains the one value enforcement
           * reads. Falls back to null for any plan code outside the canonical catalog (should not
           * happen for the seeded Business plans, but never fabricates a band for one that isn't
           * recognized).
           */
          minArrangementsMonthly: BUSINESS_PLAN_VOLUME_BANDS[plan.code]?.min ?? null,
        };
      }),
    );
    return NextResponse.json({ plans: withLimits }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOnboardingPlansGetHandler(getAuthService(), getPricingService(), new DrizzlePricingPlanEntitlementRepository())(request);
}

export const GET = withErrorHandling("organizations_onboarding_plans", handleGet);
