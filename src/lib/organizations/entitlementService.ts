import "server-only";
import type { PricingService } from "@/lib/pricing/pricingService";
import type { PricingPlanEntitlementRepository } from "@/lib/pricing/pricingPlanEntitlementRepository";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02),
 * Phase 5: answers "HAS THE ORGANIZATION PAID FOR THE FEATURE?" — entirely separate from
 * OrganizationAuthorizationService's "WHO may perform this action?" (membership/capability). A
 * paid-feature operation requires BOTH; this service never takes a userId/role at all, so there is
 * no code path here for an OWNER (or anyone else) to bypass a plan entitlement — entitlement is a
 * property of the organization's subscription, never of who is asking.
 *
 * `entitled`/`getEntitlementLimit` both resolve through PricingService.getActivePlan("business",
 * organizationId) — the existing, pre-existing-architecture confirmation that a business's
 * subscription belongs to the organization (business_profile), never to the individual user. If
 * there is no active subscription at all, every feature is simply not entitled — this is the one
 * and only "expired/inactive subscription blocks paid org features" rule, and it is intentionally
 * just that simple: nothing here reads subscription.currentPeriodStart/End to auto-expire a
 * still-"active" subscription row, since no background job or lifecycle process in this codebase
 * currently transitions status on period end — inventing that behavior now would be a new
 * subscription-lifecycle feature, not a foundation-layer authorization fix.
 *
 * Recovering from an inactive subscription (re-subscribing) is a CAPABILITY-gated action
 * (`manage_subscription`, via OrganizationAuthorizationService.can), never an entitlement-gated
 * one — so an OWNER/FINANCE_ADMIN can always reach that surface regardless of what this service
 * answers, satisfying "do not lock an OWNER out of the path required to restore service."
 *
 * "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-5 (Codex re-verification): a
 * `subscription` row's `status` column defaults to "active" the instant `BusinessOnboardingService.
 * selectTier` creates it — before any billing provider has ever been contacted (Section 19's own
 * audit found no OTHER existing field distinguishing "locally selected" from "provider-confirmed" —
 * `providerSubscriptionReference` is not sufficient either, since `PlatformBillingWebhookService.
 * syncCheckoutCompleted` syncs it even for a NOT-yet-eligible checkout per P0-4). So `getActivePlan`
 * alone can never be trusted as proof of PAID ENTITLEMENT. The one existing field that IS exactly
 * "has Stripe genuinely confirmed this organization active" is `business_profile.onboarding_step`
 * reaching `"billing_setup_complete"` — set ONLY by `PlatformBillingWebhookService.
 * activateOnboardingIfNeeded`, itself only ever called once the provider's own authoritative state is
 * "active" (P0-4). Requiring it here closes the gap with NO new column/migration — reusing an
 * existing, already-correct signal — and never touches verification/legal acceptance, which remain
 * separate, independent gates this service has never enforced and still does not.
 */
export class EntitlementService {
  constructor(
    private readonly pricing: PricingService,
    private readonly entitlements: PricingPlanEntitlementRepository,
    private readonly businessProfiles: BusinessProfileRepository,
  ) {}

  private async isProviderConfirmedActive(organizationId: string): Promise<boolean> {
    const profile = await this.businessProfiles.findById(organizationId);
    return profile?.onboardingStep === "billing_setup_complete";
  }

  async entitled(organizationId: string, featureKey: string): Promise<boolean> {
    if (!(await this.isProviderConfirmedActive(organizationId))) return false;
    const plan = await this.pricing.getActivePlan("business", organizationId);
    if (!plan) return false;
    const row = await this.entitlements.findByPlanAndFeature(plan.id, featureKey);
    return row?.enabled ?? false;
  }

  /**
   * Returns the numeric cap, or null for "unlimited" (only meaningful when `entitled` is true).
   * When the feature is not entitled at all (no active subscription, no catalog row, the row is
   * disabled, or the organization's billing is not yet provider-confirmed), returns 0 — a real,
   * deliberate "no usage permitted" cap — never null, so "not entitled" is never confused with
   * "unlimited" by a caller that skips the `entitled` check.
   */
  async getEntitlementLimit(organizationId: string, featureKey: string): Promise<number | null> {
    if (!(await this.isProviderConfirmedActive(organizationId))) return 0;
    const plan = await this.pricing.getActivePlan("business", organizationId);
    if (!plan) return 0;
    const row = await this.entitlements.findByPlanAndFeature(plan.id, featureKey);
    if (!row || !row.enabled) return 0;
    return row.limitValue;
  }
}
