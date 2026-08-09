import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { PricingService } from "./pricingService";
import { createTestPricingService } from "./testFakes";

const PROFILE_ID = "profile-1";

describe("PricingService", () => {
  let ctx: ReturnType<typeof createTestPricingService>;

  beforeEach(() => {
    ctx = createTestPricingService();
  });

  it("has no active plan before subscribing", async () => {
    expect(await ctx.pricingService.getActivePlan("personal", PROFILE_ID)).toBeNull();
  });

  it("subscribes to a plan and it becomes the active plan", async () => {
    ctx.plans.seed({ kind: "personal", code: "personal_free", name: "Free" });
    const sub = await ctx.pricingService.subscribe("personal", PROFILE_ID, "personal_free");
    expect(sub.status).toBe("active");
    const active = await ctx.pricingService.getActivePlan("personal", PROFILE_ID);
    expect(active?.code).toBe("personal_free");
  });

  it("rejects subscribing to an unknown plan code", async () => {
    await expect(ctx.pricingService.subscribe("personal", PROFILE_ID, "does-not-exist")).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects subscribing to an inactive plan", async () => {
    ctx.plans.seed({ kind: "personal", code: "retired_plan", name: "Retired", isActive: false });
    await expect(ctx.pricingService.subscribe("personal", PROFILE_ID, "retired_plan")).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects subscribing a personal profile to a business-kind plan", async () => {
    ctx.plans.seed({ kind: "business", code: "business_standard", name: "Business Standard" });
    await expect(ctx.pricingService.subscribe("personal", PROFILE_ID, "business_standard")).rejects.toThrow(
      ValidationError,
    );
  });

  it("switching plans cancels the old subscription prospectively (only one active at a time)", async () => {
    ctx.plans.seed({ kind: "personal", code: "personal_free", name: "Free" });
    ctx.plans.seed({ kind: "personal", code: "personal_subscription", name: "Subscription" });

    const first = await ctx.pricingService.subscribe("personal", PROFILE_ID, "personal_free");
    await ctx.pricingService.subscribe("personal", PROFILE_ID, "personal_subscription");

    const active = await ctx.pricingService.getActivePlan("personal", PROFILE_ID);
    expect(active?.code).toBe("personal_subscription");

    const canceledFirst = await ctx.subscriptions.findActiveByProfile("personal", PROFILE_ID);
    expect(canceledFirst?.id).not.toBe(first.id); // the free plan's subscription row is no longer active
  });

  it("free-tier allowance is measured by count, never a dollar amount", async () => {
    const plan = ctx.plans.seed({
      kind: "personal",
      code: "personal_free",
      name: "Free",
      freeAgreementAllowance: 3,
      freeIncludedPaymentsAllowance: 12,
    });
    expect(plan.freeAgreementAllowance).toBe(3);
    expect(plan.freeIncludedPaymentsAllowance).toBe(12);
    // No dollar-amount field exists for the free-tier threshold at all —
    // the type itself has no such field (see PricingPlanRecord).
    expect("freeDollarThreshold" in plan).toBe(false);
  });

  it("reports zero free-tier usage (no agreement/payment tables exist yet — Sprint 5+/9+)", async () => {
    const usage = await ctx.pricingService.getFreeTierUsage("personal", PROFILE_ID);
    expect(usage).toEqual({ agreementsUsed: 0, paymentsUsed: 0 });
  });

  it("has no capability to terminate or mutate an agreement (structural, not just untested)", () => {
    const service = ctx.pricingService as unknown as Record<string, unknown>;
    expect(typeof service.terminateAgreement).toBe("undefined");
    expect(typeof service.cancelAgreement).toBe("undefined");
    expect(typeof service.deleteAgreement).toBe("undefined");
    // The only methods this service has at all:
    const methodNames = Object.getOwnPropertyNames(PricingService.prototype).filter((n) => n !== "constructor");
    expect(methodNames.sort()).toEqual(["getActivePlan", "getFreeTierUsage", "subscribe"]);
  });
});
