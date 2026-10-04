import { describe, expect, it } from "vitest";
import { BUSINESS_PLAN_VOLUME_BANDS, seedCanonicalBusinessPlans } from "./seedCanonicalBusinessPlans";
import { InMemoryPricingPlanEntitlementRepository, InMemoryPricingPlanRepository } from "./testFakes";

const ALL_CODES = [
  "paid2you_business_starter",
  "paid2you_business_core",
  "paid2you_business_growth",
  "paid2you_business_scale",
  "paid2you_business_enterprise",
];

describe("seedCanonicalBusinessPlans", () => {
  it("creates exactly Starter/Core/Growth/Scale/Enterprise with the production commercial model's exact prices and codes", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();

    const result = await seedCanonicalBusinessPlans(plans, entitlements);

    expect(result.created).toEqual(ALL_CODES);
    expect(result.alreadyPresent).toEqual([]);

    const starter = await plans.findByCode("paid2you_business_starter");
    const core = await plans.findByCode("paid2you_business_core");
    const growth = await plans.findByCode("paid2you_business_growth");
    const scale = await plans.findByCode("paid2you_business_scale");
    const enterprise = await plans.findByCode("paid2you_business_enterprise");

    expect(starter?.monthlyFeeMinorUnits).toBe(9_900); // $99/month
    expect(core?.monthlyFeeMinorUnits).toBe(19_900); // $199/month — unchanged from the prior catalog
    expect(growth?.monthlyFeeMinorUnits).toBe(69_900); // $699/month — unchanged
    expect(scale?.monthlyFeeMinorUnits).toBe(199_900); // $1,999/month — unchanged
    expect(enterprise?.monthlyFeeMinorUnits).toBe(500_000); // starting $5,000/month — unchanged
    expect(starter?.kind).toBe("business");
    expect(starter?.isActive).toBe(true);
  });

  it("seeds new_arrangements_monthly ceilings matching the production volume bands exactly, and leaves Enterprise unlimited at the catalog level", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);

    const starter = await plans.findByCode("paid2you_business_starter");
    const core = await plans.findByCode("paid2you_business_core");
    const growth = await plans.findByCode("paid2you_business_growth");
    const scale = await plans.findByCode("paid2you_business_scale");
    const enterprise = await plans.findByCode("paid2you_business_enterprise");

    const limitFor = async (pricingPlanId: string) => {
      const rows = await entitlements.listByPlan(pricingPlanId);
      return rows.find((r) => r.featureKey === "new_arrangements_monthly")?.limitValue;
    };

    expect(await limitFor(starter!.id)).toBe(24); // 1–24
    expect(await limitFor(core!.id)).toBe(99); // 25–99
    expect(await limitFor(growth!.id)).toBe(499); // 100–499
    expect(await limitFor(scale!.id)).toBe(1_999); // 500–1,999
    expect(await limitFor(enterprise!.id)).toBe(null); // 2,000+ / custom
  });

  it("every canonical plan is also entitled to organization_agreements, unconditionally", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);

    for (const code of ALL_CODES) {
      const plan = await plans.findByCode(code);
      const rows = await entitlements.listByPlan(plan!.id);
      const orgAgreements = rows.find((r) => r.featureKey === "organization_agreements");
      expect(orgAgreements?.enabled).toBe(true);
    }
  });

  it("is idempotent — re-running against an already-seeded catalog creates nothing new", async () => {
    const plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);

    const second = await seedCanonicalBusinessPlans(plans, entitlements);

    expect(second.created).toEqual([]);
    expect(second.alreadyPresent).toEqual(ALL_CODES);
  });

  describe("BUSINESS_PLAN_VOLUME_BANDS (display-only band bounds)", () => {
    it("every band's [min, max] matches the production commercial model exactly, with no gaps or overlaps", () => {
      expect(BUSINESS_PLAN_VOLUME_BANDS.paid2you_business_starter).toEqual({ min: 0, max: 24 }); // zero usage is still Starter — no free tier.
      expect(BUSINESS_PLAN_VOLUME_BANDS.paid2you_business_core).toEqual({ min: 25, max: 99 });
      expect(BUSINESS_PLAN_VOLUME_BANDS.paid2you_business_growth).toEqual({ min: 100, max: 499 });
      expect(BUSINESS_PLAN_VOLUME_BANDS.paid2you_business_scale).toEqual({ min: 500, max: 1_999 });
      expect(BUSINESS_PLAN_VOLUME_BANDS.paid2you_business_enterprise).toEqual({ min: 2_000, max: null });
    });

    it.each([
      [0, "paid2you_business_starter"],
      [1, "paid2you_business_starter"],
      [24, "paid2you_business_starter"],
      [25, "paid2you_business_core"],
      [99, "paid2you_business_core"],
      [100, "paid2you_business_growth"],
      [499, "paid2you_business_growth"],
      [500, "paid2you_business_scale"],
      [1_999, "paid2you_business_scale"],
      [2_000, "paid2you_business_enterprise"],
    ])("volume %i falls into the %s band, at every boundary", (volume, expectedCode) => {
      const match = Object.entries(BUSINESS_PLAN_VOLUME_BANDS).find(([, band]) => volume >= band.min && (band.max === null || volume <= band.max));
      expect(match?.[0]).toBe(expectedCode);
    });
  });
});
