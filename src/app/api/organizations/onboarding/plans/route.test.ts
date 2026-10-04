import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { PricingService } from "@/lib/pricing/pricingService";
import { seedCanonicalBusinessPlans } from "@/lib/pricing/seedCanonicalBusinessPlans";
import { InMemoryPricingPlanEntitlementRepository, InMemoryPricingPlanRepository, InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { createOnboardingPlansGetHandler } from "./route";

describe("GET /api/organizations/onboarding/plans", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let pricing: PricingService;
  let entitlements: InMemoryPricingPlanEntitlementRepository;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    const plans = new InMemoryPricingPlanRepository();
    entitlements = new InMemoryPricingPlanEntitlementRepository();
    pricing = new PricingService(plans, new InMemorySubscriptionRepository());
    await seedCanonicalBusinessPlans(plans, entitlements);

    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "founder@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handler() {
    return withErrorHandling("test", createOnboardingPlansGetHandler(authCtx.authService, pricing, entitlements));
  }

  it("lists the canonical Business plans with their arrangement limits — never a second, hard-coded catalog", async () => {
    const response = await handler()(new NextRequest("http://localhost/api/organizations/onboarding/plans", { headers: { cookie: `p2p_session=${token}` } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      plans: Array<{ code: string; name: string; monthlyFeeMinorUnits: number | null; newArrangementsMonthlyLimit: number | null; minArrangementsMonthly: number | null }>;
    };
    expect(body.plans.map((p) => p.code).sort()).toEqual([
      "paid2you_business_core",
      "paid2you_business_enterprise",
      "paid2you_business_growth",
      "paid2you_business_scale",
      "paid2you_business_starter",
    ]);
    const starter = body.plans.find((p) => p.code === "paid2you_business_starter")!;
    expect(starter.monthlyFeeMinorUnits).toBe(9_900);
    expect(starter.minArrangementsMonthly).toBe(0); // zero qualifying arrangements is still Starter — no free tier.
    expect(starter.newArrangementsMonthlyLimit).toBe(24);
    const core = body.plans.find((p) => p.code === "paid2you_business_core")!;
    expect(core.monthlyFeeMinorUnits).toBe(19_900);
    expect(core.minArrangementsMonthly).toBe(25);
    expect(core.newArrangementsMonthlyLimit).toBe(99);
    const enterprise = body.plans.find((p) => p.code === "paid2you_business_enterprise")!;
    expect(enterprise.minArrangementsMonthly).toBe(2_000);
    // Enterprise is never a fixed arrangement count — null means custom/unlimited, not a fabricated number.
    expect(enterprise.newArrangementsMonthlyLimit).toBeNull();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(new NextRequest("http://localhost/api/organizations/onboarding/plans"));
    expect(response.status).toBe(401);
  });
});
