import { describe, expect, it } from "vitest";
import { seedCanonicalBusinessPlans } from "./seedCanonicalBusinessPlans";
import { InMemoryPricingPlanEntitlementRepository, InMemoryPricingPlanRepository, InMemorySubscriptionRepository } from "./testFakes";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Requirement 23/26: proves the Enterprise
 * catalog-vs-negotiated price/limit distinction this phase's schema change (subscription.
 * negotiated_monthly_fee_minor_units / negotiated_new_arrangements_monthly_limit) exists to
 * represent — without ever inventing or hardcoding a specific customer's actual negotiated terms.
 */
describe("Enterprise custom contract-price/limit capability", () => {
  it("preserves the catalog starting/reference price untouched by any organization's negotiated price", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);
    const enterprise = await plans.findByCode("paid2you_business_enterprise");

    const subA = await subscriptions.insert({ profileKind: "business", profileId: "org-a", pricingPlanId: enterprise!.id });
    await subscriptions.setNegotiatedTerms(subA.id, { negotiatedMonthlyFeeMinorUnits: 850_000, negotiatedNewArrangementsMonthlyLimit: 3_000 });

    const catalogAfter = await plans.findByCode("paid2you_business_enterprise");
    expect(catalogAfter?.monthlyFeeMinorUnits).toBe(500_000); // the "starting $5,000/month" catalog value — never overwritten.
  });

  it("an organization-specific negotiated price is nullable and can differ from the catalog value", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);
    const enterprise = await plans.findByCode("paid2you_business_enterprise");

    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-a", pricingPlanId: enterprise!.id });
    expect(sub.negotiatedMonthlyFeeMinorUnits).toBeNull(); // nullable until actually negotiated.

    await subscriptions.setNegotiatedTerms(sub.id, { negotiatedMonthlyFeeMinorUnits: 1_200_000, negotiatedNewArrangementsMonthlyLimit: null });
    const updated = await subscriptions.findById(sub.id);
    expect(updated?.negotiatedMonthlyFeeMinorUnits).toBe(1_200_000);
    expect(updated?.negotiatedMonthlyFeeMinorUnits).not.toBe(enterprise!.monthlyFeeMinorUnits);
  });

  it("one organization's negotiated price/limit never affects another organization's subscription", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);
    const enterprise = await plans.findByCode("paid2you_business_enterprise");

    const subA = await subscriptions.insert({ profileKind: "business", profileId: "org-a", pricingPlanId: enterprise!.id });
    const subB = await subscriptions.insert({ profileKind: "business", profileId: "org-b", pricingPlanId: enterprise!.id });
    await subscriptions.setNegotiatedTerms(subA.id, { negotiatedMonthlyFeeMinorUnits: 900_000, negotiatedNewArrangementsMonthlyLimit: 4_000 });

    const bAfter = await subscriptions.findById(subB.id);
    expect(bAfter?.negotiatedMonthlyFeeMinorUnits).toBeNull();
    expect(bAfter?.negotiatedNewArrangementsMonthlyLimit).toBeNull();
  });

  it("Core/Growth/Scale subscriptions are never given a negotiated override by the canonical seed", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);
    const core = await plans.findByCode("paid2you_business_core");

    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-core", pricingPlanId: core!.id });
    expect(sub.negotiatedMonthlyFeeMinorUnits).toBeNull();
    expect(sub.negotiatedNewArrangementsMonthlyLimit).toBeNull();
  });
});
