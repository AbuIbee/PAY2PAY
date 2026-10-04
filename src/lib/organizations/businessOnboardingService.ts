import "server-only";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { LegalAcceptanceRecord } from "@/lib/legal/legalAcceptanceRepository";
import type { LegalAcceptanceService, LegalDocumentAcceptanceStatus } from "@/lib/legal/legalAcceptanceService";
import { REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES } from "@/lib/legal/legalDocumentVersions";
import type { PricingService, SubscriptionRecord, SubscriptionRepository } from "@/lib/pricing/pricingService";
import type {
  BusinessIndustry,
  BusinessOnboardingStep,
  BusinessProfileRecord,
  BusinessProfileRepository,
  BusinessRepresentativeDetails,
} from "@/lib/profiles/businessProfileService";
import type { BusinessProfileService } from "@/lib/profiles/businessProfileService";
import type { BusinessStaffMemberRepository } from "@/lib/staff/staffService";
import { BusinessActivationService, type BusinessActivationStatus } from "./businessActivationService";
import { advanceBusinessOnboardingStepIfNeeded, businessOnboardingStepIndex as stepIndex } from "./businessOnboardingStepOrder";
import type { BusinessVerificationRecord, BusinessVerificationRepository } from "./businessVerificationRepository";
import type { BusinessVerificationService } from "./businessVerificationService";
import type { OrganizationRoleService } from "./organizationRoleService";
import type { PlatformBillingService } from "./platformBillingService";
import type { BillingSummary } from "./platformBillingService";

export interface BusinessOnboardingState {
  profile: BusinessProfileRecord;
  verification: BusinessVerificationRecord | null;
  subscription: SubscriptionRecord | null;
  activation: BusinessActivationStatus;
  legalAcceptance: readonly LegalDocumentAcceptanceStatus[];
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 2/3: the one orchestration seam for the
 * resumable Business onboarding flow — Business Details -> Verification -> Tier Selection ->
 * Subscription/Billing -> (independently computed) ACTIVE. Every step here composes existing,
 * already-tested domain services (BusinessProfileService, OrganizationRoleService,
 * BusinessVerificationService, PricingService, PlatformBillingService) rather than inventing
 * parallel logic — this class holds no business rule those services don't already own; it only
 * sequences them and enforces the monotonic step order.
 *
 * Every mutating method re-verifies the caller OWNS the organization (never trusts a client-supplied
 * organizationId) via the exact same cross-user-isolated check `BusinessProfileService.
 * getOwnedBusinessProfile` already provides — no new authorization logic invented here.
 */
export class BusinessOnboardingService {
  constructor(
    private readonly businessProfiles: BusinessProfileRepository,
    private readonly businessProfileService: BusinessProfileService,
    private readonly staffMembers: BusinessStaffMemberRepository,
    private readonly organizationRoles: OrganizationRoleService,
    /**
     * Lazy — resolved only inside `submitVerification`, never at construction. Resolving
     * `getBusinessVerificationProvider()` eagerly would make constructing THIS WHOLE service throw
     * `ProviderNotAvailableError` whenever the verification provider is unconfigured, which would
     * break every onboarding step (including Business Details, which has nothing to do with
     * verification) — not just the verification step itself. Mirrors `billing` below for the
     * identical reason.
     */
    private readonly getVerificationService: () => BusinessVerificationService,
    private readonly verifications: BusinessVerificationRepository,
    private readonly pricing: PricingService,
    private readonly subscriptions: SubscriptionRepository,
    /** Lazy — resolved only inside `setUpBilling`. See `getVerificationService`'s own doc comment for why. */
    private readonly getBillingService: () => PlatformBillingService,
    private readonly activation: BusinessActivationService,
    private readonly legalAcceptance: LegalAcceptanceService,
  ) {}

  private async requireOwnedOrganization(actingUserId: string, organizationId: string): Promise<BusinessProfileRecord> {
    const profile = await this.businessProfileService.getOwnedBusinessProfile(actingUserId, organizationId);
    if (!profile) throw new ForbiddenError("You do not have access to this business organization.");
    return profile;
  }

  private async advanceStep(organizationId: string, current: BusinessOnboardingStep, next: BusinessOnboardingStep): Promise<void> {
    await advanceBusinessOnboardingStepIfNeeded(this.businessProfiles, organizationId, current, next);
  }

  /**
   * Requirement 1/2: the ONLY way a Business organization comes into existence — never a Personal
   * profile converted into one. Starting (no `organizationId`) creates it (atomic with its Owner
   * membership, via the pre-existing BusinessProfileService), seeds the new organization_role
   * catalog (Owner/Manager/Employee 2/Employee 3 — Requirement 10/12), and points the Owner
   * membership's `roleId` at the new Owner role. Resuming (an existing `organizationId` still at
   * "details_pending"/"details_complete") amends the same details in place instead of creating a
   * second organization.
   */
  async submitBusinessDetails(input: {
    actingUserId: string;
    organizationId: string | null;
    legalBusinessName: string;
    displayName: string;
    entityType: string;
    dbaName: string | null;
    industry: BusinessIndustry;
    formationJurisdiction: string;
    businessAddress: unknown;
    businessEmail: string;
    businessPhone: string | null;
    website: string | null;
    country: string;
    state: string;
    representative: BusinessRepresentativeDetails;
  }): Promise<BusinessProfileRecord> {
    let profile: BusinessProfileRecord;
    if (input.organizationId) {
      profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    } else {
      profile = await this.businessProfileService.createBusinessProfile({
        ownerUserId: input.actingUserId,
        legalBusinessName: input.legalBusinessName,
        displayName: input.displayName,
        entityType: input.entityType,
        businessAddress: input.businessAddress,
        country: input.country,
        state: input.state,
      });
      const ownerMembership = await this.staffMembers.findActiveByBusinessAndUser(profile.id, input.actingUserId);
      if (!ownerMembership) {
        throw new ValidationError("Owner membership was not created alongside this organization — cannot continue onboarding.");
      }
      const roles = await this.organizationRoles.seedDefaultRolesForNewOrganization(profile.id);
      await this.staffMembers.setRoleId(ownerMembership.id, roles.ownerRoleId);
    }

    await this.businessProfiles.updateOnboardingDetails(profile.id, {
      dbaName: input.dbaName,
      industry: input.industry,
      formationJurisdiction: input.formationJurisdiction,
      businessEmail: input.businessEmail,
      website: input.website,
      representative: input.representative,
    });
    await this.advanceStep(profile.id, profile.onboardingStep, "details_complete");

    const updated = await this.businessProfiles.findById(profile.id);
    if (!updated) throw new ValidationError("Organization disappeared during onboarding.");
    return updated;
  }

  /**
   * Requirement 3/Section 9: `taxId` is read once from the request body and passed straight through
   * to BusinessVerificationService — never persisted here or anywhere else in application-readable
   * form (see that service's own doc comment). Production verification is currently NOT_CONFIGURED
   * (BusinessVerificationProvider) — this call surfaces that failure directly rather than fabricating
   * a submission; onboarding progress made so far is untouched either way.
   */
  async submitVerification(input: { actingUserId: string; organizationId: string; taxId: string }): Promise<BusinessVerificationRecord> {
    const profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    if (stepIndex(profile.onboardingStep) < stepIndex("details_complete")) {
      throw new ValidationError("Complete business details before submitting verification.");
    }
    if (!profile.representative || !profile.industry || !profile.formationJurisdiction || !profile.businessEmail) {
      throw new ValidationError("Business details are incomplete — cannot submit verification.");
    }

    const record = await this.getVerificationService().submit(input.actingUserId, {
      organizationId: profile.id,
      legalBusinessName: profile.legalBusinessName,
      entityType: profile.entityType,
      taxId: input.taxId,
      formationJurisdiction: profile.formationJurisdiction,
      businessAddress: (profile.businessAddress as Record<string, unknown>) ?? {},
      representative: profile.representative,
    });
    await this.advanceStep(profile.id, profile.onboardingStep, "verification_submitted");
    return record;
  }

  /**
   * Requirement 4/Section 4: tier selection — plan existence/kind validation is PricingService's own
   * (unchanged, reused, not duplicated here).
   *
   * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-5: this is the INITIAL, pre-subscription
   * plan-selection step ONLY — never a second, free way to change an already-provider-confirmed
   * subscription's plan (that is `PlatformBillingService.changePlan`'s own job, reached only through
   * the Billing & Subscription surface, which actually calls Stripe). Two independent guards enforce
   * that boundary:
   *   1. Once onboarding has reached `billing_setup_complete` (only ever set by
   *      `PlatformBillingWebhookService` once Stripe has genuinely confirmed an active subscription —
   *      see that service's own `activateOnboardingIfNeeded`), this organization is no longer in the
   *      "initial plan selection" stage at all, regardless of what the local `subscription.status`
   *      column (a structurally separate, Business-AND-Personal-shared column that defaults to
   *      "active" at row-creation time, before any provider is ever involved) happens to read.
   *   2. Even before `billing_setup_complete`, once ANY existing subscription for this organization
   *      already carries a real `providerSubscriptionReference` (a genuine Stripe Checkout session
   *      already completed for it, even if not yet eligible for activation — see
   *      `PlatformBillingWebhookService.syncCheckoutCompleted`), re-selecting a tier here would locally
   *      cancel-and-replace that row with ZERO Stripe involvement — exactly the bypass Codex found.
   * Enterprise is rejected outright, mirroring the same rule already enforced at the
   * change-plan route and `PlatformBillingService.beginHostedCheckout` — never reachable through
   * standard self-service at any stage.
   */
  async selectTier(input: { actingUserId: string; organizationId: string; planCode: string }): Promise<SubscriptionRecord> {
    const profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    if (stepIndex(profile.onboardingStep) < stepIndex("verification_submitted")) {
      throw new ValidationError("Submit business verification before selecting a tier.");
    }
    if (profile.onboardingStep === "billing_setup_complete") {
      throw new ValidationError("This organization's billing is already set up — change your plan from Billing & Subscription instead.");
    }
    if (input.planCode === "paid2you_business_enterprise") {
      throw new ValidationError("Enterprise is not available for self-service tier selection — contact Paid2You directly.");
    }
    const existing = await this.subscriptions.findActiveByProfile("business", profile.id);
    if (existing?.providerSubscriptionReference) {
      throw new ValidationError("This organization already has a billing-provider subscription — change your plan from Billing & Subscription instead.");
    }
    const subscription = await this.pricing.subscribe("business", profile.id, input.planCode);
    await this.advanceStep(profile.id, profile.onboardingStep, "tier_selected");
    return subscription;
  }

  /**
   * Requirement 4/Section 5: the subscription payment method / authorization step. Production
   * billing is currently NOT_CONFIGURED (PlatformBillingProvider) — PlatformBillingService.
   * setUpBilling throws directly when that's the case; this method does NOT catch that error and
   * does NOT advance the onboarding step on failure, so a provider-unavailable attempt never erases
   * or corrupts onboarding progress (Section 5's own explicit requirement) and can simply be retried
   * once a real provider is configured.
   *
   * "PAID2YOU — FINAL SINGLE P0 DEFECT REMEDIATION" (2026-10-04), P0-5: this method DELIBERATELY does
   * NOT advance `onboardingStep` to `billing_setup_complete` itself. `PlatformBillingProvider.
   * startSubscription`'s own return shape (`StartSubscriptionResult`) carries only opaque
   * references/billing-period dates — no authoritative status — and this method never calls
   * `retrieveSubscriptionState` either, so there was never any provider-confirmed fact here to gate
   * on. Mirrors `beginHostedCheckout`'s own already-established, already-verified split exactly:
   * `billing_setup_complete` has exactly ONE meaning across this entire codebase — "Paid2You has
   * authoritative evidence the standard Stripe-backed subscription is active" — and exactly ONE writer
   * capable of establishing that fact: `PlatformBillingWebhookService.activateOnboardingIfNeeded`,
   * which only ever runs after re-fetching the provider's own authoritative state and confirming it is
   * genuinely `"active"` (P0-4). `setUpBilling` already persists the provider customer/subscription
   * references onto this organization's row (inside `PlatformBillingService.setUpBilling`) BEFORE
   * returning, so the real Stripe `customer.subscription.created`/`.updated` webhook that Stripe fires
   * for this same subscription resolves back to this organization exactly as it would for a
   * hosted-checkout-originated one, and completes onboarding the moment (and only once) Stripe
   * confirms "active" — with zero duplicated status-checking logic here.
   */
  async setUpBilling(input: { actingUserId: string; organizationId: string; billingEmail: string; paymentMethodToken: string }): Promise<BillingSummary> {
    const profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    if (stepIndex(profile.onboardingStep) < stepIndex("tier_selected")) {
      throw new ValidationError("Select a tier before setting up billing.");
    }
    return this.getBillingService().setUpBilling({
      organizationId: profile.id,
      billingEmail: input.billingEmail,
      legalName: profile.legalBusinessName,
      paymentMethodToken: input.paymentMethodToken,
    });
  }

  /**
   * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7/8-D/8-E: the real
   * hosted-checkout billing entry point — returns a provider-hosted URL for the Business to be
   * redirected to; the caller is NEVER asked for a provider PaymentMethod id. Mirrors `setUpBilling`'s
   * own ownership/tier-selected gate, and additionally enforces the required-legal-acceptance gate
   * explicitly (Section 8-E's own "required legal gate enforced" test-matrix item) — `setUpBilling`
   * predates that gate and is left as-is to avoid changing its own already-tested behavior.
   * Deliberately does NOT advance `onboardingStep` itself — creating a checkout session is not
   * completion. `PlatformBillingWebhookService`'s own `checkout.session.completed` handling advances
   * `onboardingStep` to `billing_setup_complete` (via the shared `advanceBusinessOnboardingStepIfNeeded`
   * helper — see that helper's own doc comment, which already anticipated this exact split) only once
   * a verified webhook confirms the hosted checkout actually completed — never from this call, and
   * never from the browser redirect alone.
   */
  async beginHostedCheckout(input: { actingUserId: string; organizationId: string; billingEmail: string; successUrl: string; cancelUrl: string }): Promise<{ hostedUrl: string }> {
    const profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    if (stepIndex(profile.onboardingStep) < stepIndex("tier_selected")) {
      throw new ValidationError("Select a tier before setting up billing.");
    }
    const legalStatus = await this.legalAcceptance.getOrganizationAcceptanceStatus(profile.id, REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES);
    if (!legalStatus.every((d) => d.accepted)) {
      throw new ValidationError("Accept the required legal agreements before setting up billing.");
    }

    return this.getBillingService().beginHostedCheckout({
      organizationId: profile.id,
      billingEmail: input.billingEmail,
      legalName: profile.legalBusinessName,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
  }

  /** Server-derived resumability: the single source of truth for "where should this user resume?" — never React component state. */
  async getOnboardingState(input: { actingUserId: string; organizationId: string }): Promise<BusinessOnboardingState> {
    const profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    const [verification, subscription, activationStatus, legalAcceptanceStatus] = await Promise.all([
      this.verifications.findLatestForOrganization(profile.id),
      this.subscriptions.findActiveByProfile("business", profile.id),
      this.activation.computeActivationStatus(profile.id),
      this.legalAcceptance.getOrganizationAcceptanceStatus(profile.id, REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES),
    ]);
    return { profile, verification, subscription, activation: activationStatus, legalAcceptance: legalAcceptanceStatus };
  }

  /**
   * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 3/8: records ONE required document's
   * acceptance for this organization — `requireOwnedOrganization` is the SAME ownership check every
   * other onboarding mutation already uses (never a new/competing authorization mechanism), so only
   * the organization's owner (the same person going through onboarding) can accept on its behalf,
   * exactly matching "the Business owner/authorized billing administrator must affirm." The acting
   * user id and the server clock are the only things ever recorded — `documentVersion` is resolved
   * entirely inside `LegalAcceptanceService`, never accepted from the caller at all.
   */
  async acceptLegalDocument(input: { actingUserId: string; organizationId: string; documentType: string }): Promise<LegalAcceptanceRecord> {
    const profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    if (stepIndex(profile.onboardingStep) < stepIndex("tier_selected")) {
      throw new ValidationError("Select a tier before accepting legal agreements.");
    }
    return this.legalAcceptance.recordAcceptance({ userId: input.actingUserId, organizationId: profile.id, documentType: input.documentType });
  }

  /** The legal-acceptance step's own read — see `/api/organizations/onboarding/legal`'s own doc comment. */
  async getLegalAcceptanceStatus(input: { actingUserId: string; organizationId: string }): Promise<readonly LegalDocumentAcceptanceStatus[]> {
    const profile = await this.requireOwnedOrganization(input.actingUserId, input.organizationId);
    return this.legalAcceptance.getOrganizationAcceptanceStatus(profile.id, REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES);
  }
}
