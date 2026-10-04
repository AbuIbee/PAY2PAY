import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import { getPlatformBillingService } from "@/lib/organizations/getPlatformBillingService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import type { PlatformBillingService } from "@/lib/organizations/platformBillingService";
import { getPricingService } from "@/lib/pricing/getPricingService";
import type { PricingService, SubscriptionRepository } from "@/lib/pricing/pricingService";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ organizationId: z.string().uuid(), planCode: z.string().trim().min(1).max(100) });

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 14/15: upgrade ONLY — Starter → Core →
 * Growth → Scale. Enterprise is never selectable here at all (Section 14: "must not automatically
 * fabricate an Enterprise contract" — reaching Enterprise requires contacting Paid2You directly, which
 * this route structurally cannot do). A downgrade attempt (target price <= current price) is rejected
 * outright, BEFORE `PlatformBillingService.changePlan` is ever called — that method would otherwise
 * silently request a "next_period" downgrade at the provider with no local rollover sync (the known,
 * deliberately deferred gap) — Section 15 requires this to be impossible to trigger, not merely
 * hidden in the UI.
 */
export function createOrganizationBillingChangePlanHandler(
  authService: AuthService,
  permissions: OrganizationPermissionService,
  pricing: PricingService,
  subscriptions: SubscriptionRepository,
  getBillingService: () => PlatformBillingService,
) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid organizationId and planCode are required.");
    const { organizationId, planCode } = parsed.data;

    await permissions.require(userId, organizationId, "subscription.manage");

    if (planCode === "paid2you_business_enterprise") {
      throw new ValidationError("Enterprise requires contacting Paid2You directly — it cannot be self-selected.");
    }

    const [currentPlan, targetPlan, subscription] = await Promise.all([
      pricing.getActivePlan("business", organizationId),
      pricing.listPlans("business").then((plans) => plans.find((p) => p.code === planCode) ?? null),
      subscriptions.findActiveByProfile("business", organizationId),
    ]);
    if (!subscription) throw new ValidationError("This organization has no active Paid2You subscription.");
    if (!targetPlan) throw new ValidationError("Unknown or inactive pricing plan.");

    const currentPrice = subscription.negotiatedMonthlyFeeMinorUnits ?? currentPlan?.monthlyFeeMinorUnits ?? 0;
    const targetPrice = targetPlan.monthlyFeeMinorUnits ?? 0;
    if (targetPrice <= currentPrice) {
      throw new ForbiddenError("Downgrading isn't available yet. Contact support if you need a lower-volume plan.");
    }

    const updated = await getBillingService().changePlan(organizationId, planCode);
    return NextResponse.json({ pricingPlanId: updated.pricingPlanId, status: updated.status }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createOrganizationBillingChangePlanHandler(getAuthService(), getOrganizationPermissionService(), getPricingService(), new DrizzleSubscriptionRepository(), () => getPlatformBillingService())(request);
}

export const POST = withErrorHandling("organizations_billing_change_plan", handlePost);
