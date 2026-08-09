import "server-only";
import { ValidationError } from "@/lib/errors";

export type PricingPlanKind = "personal" | "business";
export type ProfileKind = "personal" | "business";

export interface PricingPlanRecord {
  id: string;
  kind: PricingPlanKind;
  code: string;
  name: string;
  monthlyFeeMinorUnits: number | null;
  annualFeeMinorUnits: number | null;
  perAgreementFeeMinorUnits: number | null;
  perSuccessfulPaymentFeeMinorUnits: number | null;
  freeAgreementAllowance: number | null;
  freeIncludedPaymentsAllowance: number | null;
  isActive: boolean;
  effectiveAt: Date;
}

export interface PricingPlanRepository {
  findById(id: string): Promise<PricingPlanRecord | null>;
  findByCode(code: string): Promise<PricingPlanRecord | null>;
  listActiveByKind(kind: PricingPlanKind): Promise<PricingPlanRecord[]>;
}

export type SubscriptionStatus = "active" | "canceled";

export interface SubscriptionRecord {
  id: string;
  profileKind: ProfileKind;
  profileId: string;
  pricingPlanId: string;
  status: SubscriptionStatus;
  startedAt: Date;
  endedAt: Date | null;
}

export interface SubscriptionRepository {
  insert(input: { profileKind: ProfileKind; profileId: string; pricingPlanId: string }): Promise<SubscriptionRecord>;
  findActiveByProfile(profileKind: ProfileKind, profileId: string): Promise<SubscriptionRecord | null>;
  cancel(id: string): Promise<void>;
}

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md) pricing/
 * account-plan architecture (master spec §19). This service deliberately
 * has no method that reads, mutates, or terminates an agreement — it only
 * ever touches pricing_plan/subscription. That is what makes "an existing
 * active agreement is never terminated solely because a personal user
 * exceeds a free-tier allowance" structurally true here: there is no
 * capability in this service's surface that could do that, agreement
 * tables don't exist yet (Sprint 5+), and when they do, this service still
 * won't reach into them.
 */
export class PricingService {
  constructor(
    private readonly plans: PricingPlanRepository,
    private readonly subscriptions: SubscriptionRepository,
  ) {}

  async getActivePlan(profileKind: ProfileKind, profileId: string): Promise<PricingPlanRecord | null> {
    const subscription = await this.subscriptions.findActiveByProfile(profileKind, profileId);
    if (!subscription) return null;
    return this.plans.findById(subscription.pricingPlanId);
  }

  /**
   * Subscribing to a new plan cancels any existing active subscription and
   * starts a new one — this is a *prospective* change only (Sprint 3's
   * explicit requirement: "pricing changes apply prospectively only and
   * never rewrite a signed agreement's fee terms"). Once Sprint 5 builds
   * agreement_version, each version snapshots its own fee terms at signing
   * time rather than reading this table live, so nothing here can alter an
   * already-signed agreement's terms even indirectly.
   */
  async subscribe(profileKind: ProfileKind, profileId: string, planCode: string): Promise<SubscriptionRecord> {
    const plan = await this.plans.findByCode(planCode);
    if (!plan || !plan.isActive) {
      throw new ValidationError("Unknown or inactive pricing plan.");
    }
    if (plan.kind !== profileKind) {
      throw new ValidationError("This plan is not available for this profile type.");
    }

    const existing = await this.subscriptions.findActiveByProfile(profileKind, profileId);
    if (existing) {
      await this.subscriptions.cancel(existing.id);
    }
    return this.subscriptions.insert({ profileKind, profileId, pricingPlanId: plan.id });
  }

  /**
   * Free-tier allowance is measured by count, never a dollar amount (Sprint
   * 3's explicit requirement) — the return shape reflects that. Usage is
   * stubbed at zero: real counting requires the agreement/payment tables
   * that Sprints 5 and 9+ build, not this sprint's scope. Wiring real counts
   * in later does not require changing this method's signature or callers.
   */
  async getFreeTierUsage(
    profileKind: ProfileKind,
    profileId: string,
  ): Promise<{ agreementsUsed: number; paymentsUsed: number }> {
    // Signature intentionally accepts these now so wiring real counts in
    // later (Sprint 5/9+) doesn't change callers — no-op today.
    void profileKind;
    void profileId;
    return { agreementsUsed: 0, paymentsUsed: 0 };
  }
}
