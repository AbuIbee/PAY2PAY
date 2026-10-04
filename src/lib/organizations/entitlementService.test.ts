import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestEntitlementService } from "./testFakes";

describe("EntitlementService", () => {
  let ctx: ReturnType<typeof createTestEntitlementService>;
  const ORG_ID = randomUUID();

  beforeEach(() => {
    ctx = createTestEntitlementService();
  });

  /**
   * "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-5: a genuinely paid-entitled
   * organization is one whose billing has been PROVIDER-confirmed (`onboarding_step =
   * "billing_setup_complete"`) — never merely one with a local `subscription` row (which defaults to
   * "active" the instant a plan is selected, before any provider involvement). Tests that intend to
   * prove a real entitlement grant seed this explicitly; tests proving denial deliberately do not.
   */
  async function seedProviderConfirmedOrganization(): Promise<string> {
    const profile = await ctx.businessProfiles.insert({
      ownerUserId: randomUUID(),
      legalBusinessName: "Entitlement Test LLC",
      displayName: "Entitlement Test",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    await ctx.businessProfiles.setOnboardingStep(profile.id, "billing_setup_complete");
    return profile.id;
  }

  it("no active subscription at all: not entitled, limit is the explicit zero cap (never confused with unlimited)", async () => {
    expect(await ctx.entitlementService.entitled(ORG_ID, "staff_seats")).toBe(false);
    expect(await ctx.entitlementService.getEntitlementLimit(ORG_ID, "staff_seats")).toBe(0);
  });

  it("active subscription, feature enabled with no limit row value: entitled, unlimited (null)", async () => {
    const organizationId = await seedProviderConfirmedOrganization();
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "business_dashboard", enabled: true, limitValue: null });

    expect(await ctx.entitlementService.entitled(organizationId, "business_dashboard")).toBe(true);
    expect(await ctx.entitlementService.getEntitlementLimit(organizationId, "business_dashboard")).toBeNull();
  });

  it("active subscription, feature enabled with an explicit numeric cap", async () => {
    const organizationId = await seedProviderConfirmedOrganization();
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "staff_seats", enabled: true, limitValue: 5 });

    expect(await ctx.entitlementService.entitled(organizationId, "staff_seats")).toBe(true);
    expect(await ctx.entitlementService.getEntitlementLimit(organizationId, "staff_seats")).toBe(5);
  });

  it("active subscription, catalog row explicitly disabled: not entitled, zero cap", async () => {
    const organizationId = await seedProviderConfirmedOrganization();
    const plan = ctx.plans.seed({ kind: "business", code: "starter", name: "Starter" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "api_access", enabled: false, limitValue: null });

    expect(await ctx.entitlementService.entitled(organizationId, "api_access")).toBe(false);
    expect(await ctx.entitlementService.getEntitlementLimit(organizationId, "api_access")).toBe(0);
  });

  it("active subscription but no catalog row for this feature at all: not entitled, zero cap", async () => {
    const organizationId = await seedProviderConfirmedOrganization();
    const plan = ctx.plans.seed({ kind: "business", code: "starter", name: "Starter" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });

    expect(await ctx.entitlementService.entitled(organizationId, "api_access")).toBe(false);
    expect(await ctx.entitlementService.getEntitlementLimit(organizationId, "api_access")).toBe(0);
  });

  it("inactive (canceled) subscription blocks the paid feature even though the catalog row itself would allow it", async () => {
    const organizationId = await seedProviderConfirmedOrganization();
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    const sub = await ctx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "business_dashboard", enabled: true, limitValue: null });
    await ctx.subscriptions.cancel(sub.id);

    expect(await ctx.entitlementService.entitled(organizationId, "business_dashboard")).toBe(false);
  });

  it("entitlement is resolved purely from the organization's subscription — there is no userId/role parameter for an OWNER (or anyone) to bypass it", () => {
    expect(ctx.entitlementService.entitled.length).toBe(2);
    expect(ctx.entitlementService.getEntitlementLimit.length).toBe(2);
  });

  // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-5 (Codex re-verification): the
  // adversarial proof — a locally "active" subscription row with a fully-enabled catalog entitlement
  // is NOT sufficient for paid entitlement until the organization's billing has been genuinely
  // provider-confirmed (`billing_setup_complete`). This is the exact production gap Codex found:
  // `BusinessOnboardingService.selectTier` creates this very row, with zero Stripe involvement.
  it("P0-5: a plan merely SELECTED (local subscription row active, catalog entitlement enabled) grants NO paid entitlement before the organization's billing is provider-confirmed", async () => {
    const organizationId = randomUUID(); // deliberately NO business_profile seeded — never reached billing_setup_complete
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "business_dashboard", enabled: true, limitValue: null });

    expect(await ctx.entitlementService.entitled(organizationId, "business_dashboard")).toBe(false);
    expect(await ctx.entitlementService.getEntitlementLimit(organizationId, "business_dashboard")).toBe(0);
  });

  it("P0-5: the same organization becomes entitled the moment (and only once) its billing reaches billing_setup_complete", async () => {
    const profile = await ctx.businessProfiles.insert({
      ownerUserId: randomUUID(),
      legalBusinessName: "Entitlement Transition LLC",
      displayName: "Entitlement Transition",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    const plan = ctx.plans.seed({ kind: "business", code: "growth", name: "Growth" });
    await ctx.subscriptions.insert({ profileKind: "business", profileId: profile.id, pricingPlanId: plan.id });
    ctx.entitlements.seed({ pricingPlanId: plan.id, featureKey: "business_dashboard", enabled: true, limitValue: null });

    expect(await ctx.entitlementService.entitled(profile.id, "business_dashboard")).toBe(false);

    await ctx.businessProfiles.setOnboardingStep(profile.id, "billing_setup_complete");
    expect(await ctx.entitlementService.entitled(profile.id, "business_dashboard")).toBe(true);
  });
});
