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
  /**
   * "PAID2YOU PLATFORM EXPANSION" (2026-10-02): this table was previously, deliberately, seed-free
   * ("do not hard-code speculative prices applies to seed rows too" — docs/PROGRESS.md). This method
   * exists specifically because the platform expansion order's own Section 7 now provides the real,
   * authorized canonical prices (Core $199/Growth $699/Scale $1,999/Enterprise starting $5,000) — see
   * seedCanonicalBusinessPlans.ts, the one intended caller, never invented elsewhere.
   */
  insert(input: {
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
  }): Promise<PricingPlanRecord>;
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
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  providerCustomerReference: string | null;
  providerSubscriptionReference: string | null;
  /**
   * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Requirement 23/26: the organization-specific
   * negotiated Enterprise contract price, independent of the catalog plan's own starting/reference
   * price (`PricingPlanRecord.monthlyFeeMinorUnits`). NULL means "use the catalog price" — see
   * PlatformBillingService's own resolution order. Never set for Core/Growth/Scale in practice.
   */
  negotiatedMonthlyFeeMinorUnits: number | null;
  /** Requirement 23/DB-5: organization-specific override of the catalog entitlement's `new_arrangements_monthly` limit. NULL means "use the catalog limit." */
  negotiatedNewArrangementsMonthlyLimit: number | null;
}

export interface SubscriptionRepository {
  insert(input: { profileKind: ProfileKind; profileId: string; pricingPlanId: string }): Promise<SubscriptionRecord>;
  findById(id: string): Promise<SubscriptionRecord | null>;
  findActiveByProfile(profileKind: ProfileKind, profileId: string): Promise<SubscriptionRecord | null>;
  /** "PAID2YOU — MASTER P0" (2026-10-03), Section 24/25: resolves an incoming Stripe webhook's own subscription id back to the local row it belongs to — trusted-reference lookup, never derived from client-supplied organization/display identity. */
  findByProviderSubscriptionReference(providerSubscriptionReference: string): Promise<SubscriptionRecord | null>;
  /**
   * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7/11: resolves a `checkout.session.completed`
   * webhook's own `customer` field back to the local row it belongs to — the provider customer
   * reference is already persisted on this row by `PlatformBillingService.beginHostedCheckout` BEFORE
   * the Business is ever redirected to the provider's hosted page, so this, too, is a trusted-reference
   * lookup, never derived from client-supplied identity. Used instead of `findByProviderSubscriptionReference`
   * specifically for checkout completion, because the local row has no `providerSubscriptionReference`
   * yet the first time this event fires.
   */
  findByProviderCustomerReference(providerCustomerReference: string): Promise<SubscriptionRecord | null>;
  cancel(id: string): Promise<void>;
  /** PlatformBillingProvider's own customer/subscription identifiers — never a secret (see that file's own doc comment). */
  setProviderReferences(id: string, input: { providerCustomerReference: string | null; providerSubscriptionReference: string | null }): Promise<void>;
  setBillingPeriod(id: string, input: { currentPeriodStart: Date; currentPeriodEnd: Date }): Promise<void>;
  /** Requirement 24: defaults to end-of-period, never an immediate destructive cancel — `status` stays "active". */
  requestCancelAtPeriodEnd(id: string): Promise<void>;
  /** Requirement 25: Owner reactivates a cancel-at-period-end (not yet lapsed) subscription. */
  reactivate(id: string): Promise<void>;
  /** Requirement 23/26: sets/clears the organization-specific negotiated Enterprise price and/or arrangement-limit override. */
  setNegotiatedTerms(id: string, input: { negotiatedMonthlyFeeMinorUnits: number | null; negotiatedNewArrangementsMonthlyLimit: number | null }): Promise<void>;
  /** Requirement 26: an immediate plan change on the SAME subscription row (preserves provider customer/subscription continuity) — distinct from `subscribe()`, which cancels-and-recreates for the no-live-billing personal/initial-subscribe path. */
  setPricingPlan(id: string, pricingPlanId: string): Promise<void>;
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
   * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 4: the onboarding Tier step's own catalog
   * read — a thin pass-through to the repository's existing `listActiveByKind`, never a second,
   * UI-side copy of the canonical plan catalog (seedCanonicalBusinessPlans.ts remains the one place
   * prices/codes are defined).
   */
  async listPlans(kind: PricingPlanKind): Promise<PricingPlanRecord[]> {
    return this.plans.listActiveByKind(kind);
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
