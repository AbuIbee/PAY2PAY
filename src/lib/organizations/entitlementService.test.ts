import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestEntitlementService } from "./testFakes";

describe("EntitlementService", () => {
  let ctx: ReturnType<typeof createTestEntitlementService>;
  const ORG_ID = randomUUID();

  beforeEach(() => {
    ctx = createTestEntitlementService();
  });

  it("no active subscription at all: not entitled, limit is the explicit zero cap (never confused with unlimited)", async () => {
    expect(await ctx.entitlementService.entitled(ORG_ID, "staff_seats")).toBe(false);
    expect(await ctx.entitlementService.getEntitlementLimit(ORG_ID, "staff_seats")).toBe(0);
  });

  it("active subscription, feature enabled with no limit row value: entitled, unlimited (null)", async () => {
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: ORG_ID, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "business_dashboard", enabled: true, limitValue: null });

    expect(await ctx.entitlementService.entitled(ORG_ID, "business_dashboard")).toBe(true);
    expect(await ctx.entitlementService.getEntitlementLimit(ORG_ID, "business_dashboard")).toBeNull();
  });

  it("active subscription, feature enabled with an explicit numeric cap", async () => {
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: ORG_ID, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "staff_seats", enabled: true, limitValue: 5 });

    expect(await ctx.entitlementService.entitled(ORG_ID, "staff_seats")).toBe(true);
    expect(await ctx.entitlementService.getEntitlementLimit(ORG_ID, "staff_seats")).toBe(5);
  });

  it("active subscription, catalog row explicitly disabled: not entitled, zero cap", async () => {
    const plan = ctx.plans.seed({ kind: "business", code: "starter", name: "Starter" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: ORG_ID, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "api_access", enabled: false, limitValue: null });

    expect(await ctx.entitlementService.entitled(ORG_ID, "api_access")).toBe(false);
    expect(await ctx.entitlementService.getEntitlementLimit(ORG_ID, "api_access")).toBe(0);
  });

  it("active subscription but no catalog row for this feature at all: not entitled, zero cap", async () => {
    const plan = ctx.plans.seed({ kind: "business", code: "starter", name: "Starter" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: ORG_ID, pricingPlanId: plan.id });

    expect(await ctx.entitlementService.entitled(ORG_ID, "api_access")).toBe(false);
    expect(await ctx.entitlementService.getEntitlementLimit(ORG_ID, "api_access")).toBe(0);
  });

  it("inactive (canceled) subscription blocks the paid feature even though the catalog row itself would allow it", async () => {
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    const sub = await ctx.subscriptions.insert({ profileKind: "business", profileId: ORG_ID, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "business_dashboard", enabled: true, limitValue: null });
    await ctx.subscriptions.cancel(sub.id);

    expect(await ctx.entitlementService.entitled(ORG_ID, "business_dashboard")).toBe(false);
  });

  it("entitlement is resolved purely from the organization's subscription — there is no userId/role parameter for an OWNER (or anyone) to bypass it", () => {
    expect(ctx.entitlementService.entitled.length).toBe(2);
    expect(ctx.entitlementService.getEntitlementLimit.length).toBe(2);
  });
});
