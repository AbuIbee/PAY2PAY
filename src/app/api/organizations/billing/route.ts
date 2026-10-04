import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY, resolveCurrentPeriod } from "@/lib/organizations/arrangementUsageMetering";
import { DrizzleSubscriptionUsageReader } from "@/lib/organizations/drizzleSubscriptionUsageReader";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import { isPlatformBillingProviderConfigured } from "@/lib/organizations/getPlatformBillingProvider";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { DrizzleSubscriptionInvoiceRepository } from "@/lib/organizations/drizzleSubscriptionInvoiceRepository";
import type { SubscriptionInvoiceRepository } from "@/lib/organizations/subscriptionInvoiceRepository";
import { DrizzleSubscriptionPaymentMethodRepository } from "@/lib/organizations/drizzleSubscriptionPaymentMethodRepository";
import type { SubscriptionPaymentMethodRepository } from "@/lib/organizations/subscriptionPaymentMethodRepository";
import { BUSINESS_PLAN_VOLUME_BANDS } from "@/lib/pricing/seedCanonicalBusinessPlans";
import { deriveSubscriptionDisplayStatus } from "@/lib/organizations/subscriptionStatusPresentation";
import type { SubscriptionUsageReader } from "@/lib/organizations/subscriptionUsageReader";
import { getPricingService } from "@/lib/pricing/getPricingService";
import type { PricingPlanRepository, PricingService, SubscriptionRepository } from "@/lib/pricing/pricingService";
import { DrizzlePricingPlanRepository } from "@/lib/pricing/drizzlePricingPlanRepository";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ organizationId: z.string().uuid() });

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 10/11/13/16/17: the Billing &
 * Subscription page's own single real-data source. Every field is server-derived from existing domain
 * state — never a fabricated "payment method saved"/"subscription active" claim, and
 * `providerConfigured` tells the UI honestly whether a live PlatformBillingProvider exists at all
 * (Section 11/12: an action whose provider is unavailable must not be presented as operational).
 */
export function createOrganizationBillingGetHandler(
  authService: AuthService,
  permissions: OrganizationPermissionService,
  businessProfiles: BusinessProfileRepository,
  pricing: PricingService,
  plans: PricingPlanRepository,
  subscriptions: SubscriptionRepository,
  invoices: SubscriptionInvoiceRepository,
  paymentMethods: SubscriptionPaymentMethodRepository,
  usage: SubscriptionUsageReader,
) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");
    const organizationId = parsed.data.organizationId;

    const allowed = await permissions.can(userId, organizationId, "subscription.view");
    if (!allowed) throw new ForbiddenError("You do not have access to this organization's billing.");

    const profile = await businessProfiles.findById(organizationId);
    if (!profile) throw new ValidationError("Unknown organization.");

    const subscription = await subscriptions.findActiveByProfile("business", organizationId);
    const providerConfigured = isPlatformBillingProviderConfigured();

    if (!subscription) {
      return NextResponse.json(
        {
          organizationId,
          providerConfigured,
          subscriptionStatus: deriveSubscriptionDisplayStatus({ organizationStatus: profile.status, subscription: null, hasPastDueInvoice: false }),
          plan: null,
          band: null,
          usage: null,
          cancelAtPeriodEnd: false,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          paymentMethod: null,
          invoices: [],
          availableUpgrades: [],
        },
        { status: 200 },
      );
    }

    const [plan, allInvoices, paymentMethod, allPlans] = await Promise.all([
      plans.findById(subscription.pricingPlanId),
      invoices.listForOrganization(organizationId),
      paymentMethods.findActiveForOrganization(organizationId),
      pricing.listPlans("business"),
    ]);
    if (!plan) throw new ValidationError("This subscription's pricing plan no longer exists.");

    const { periodStart, periodEnd } = resolveCurrentPeriod(subscription);
    const usageRow = await usage.findForPeriod(subscription.id, NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY, periodStart);
    const band = BUSINESS_PLAN_VOLUME_BANDS[plan.code] ?? null;
    const hasPastDueInvoice = allInvoices.some((inv) => inv.status === "past_due");

    const currentPrice = subscription.negotiatedMonthlyFeeMinorUnits ?? plan.monthlyFeeMinorUnits ?? 0;
    // Section 14/15: only STANDARD plans priced strictly above the current one — never Enterprise
    // (contact-sales only, Section 14's own "must not automatically fabricate an Enterprise
    // contract") and never a downgrade (Section 15 — hidden, not offered, until provider lifecycle
    // sync exists).
    const availableUpgrades = allPlans.filter((p) => p.code !== "paid2you_business_enterprise" && p.code !== plan.code && (p.monthlyFeeMinorUnits ?? 0) > currentPrice);

    return NextResponse.json(
      {
        organizationId,
        providerConfigured,
        subscriptionStatus: deriveSubscriptionDisplayStatus({ organizationStatus: profile.status, subscription: { status: subscription.status, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd }, hasPastDueInvoice }),
        plan: { code: plan.code, name: plan.name, monthlyFeeMinorUnits: currentPrice, isNegotiated: subscription.negotiatedMonthlyFeeMinorUnits !== null },
        band,
        usage: { count: usageRow?.count ?? 0, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodStart: subscription.currentPeriodStart ? subscription.currentPeriodStart.toISOString() : null,
        currentPeriodEnd: subscription.currentPeriodEnd ? subscription.currentPeriodEnd.toISOString() : null,
        paymentMethod: paymentMethod ? { paymentType: paymentMethod.paymentType, displayLast4: paymentMethod.displayLast4, displayName: paymentMethod.displayName } : null,
        invoices: allInvoices.map((inv) => ({
          id: inv.id,
          periodStart: inv.periodStart.toISOString(),
          periodEnd: inv.periodEnd.toISOString(),
          amountDueMinorUnits: inv.amountDueMinorUnits,
          amountPaidMinorUnits: inv.amountPaidMinorUnits,
          status: inv.status,
          dueAt: inv.dueAt.toISOString(),
          paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
        })),
        availableUpgrades: availableUpgrades.map((p) => ({ code: p.code, name: p.name, monthlyFeeMinorUnits: p.monthlyFeeMinorUnits })),
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOrganizationBillingGetHandler(
    getAuthService(),
    getOrganizationPermissionService(),
    new DrizzleBusinessProfileRepository(),
    getPricingService(),
    new DrizzlePricingPlanRepository(),
    new DrizzleSubscriptionRepository(),
    new DrizzleSubscriptionInvoiceRepository(),
    new DrizzleSubscriptionPaymentMethodRepository(),
    new DrizzleSubscriptionUsageReader(),
  )(request);
}

export const GET = withErrorHandling("organizations_billing_get", handleGet);
