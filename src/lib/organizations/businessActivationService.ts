import "server-only";
import type { LegalAcceptanceService } from "@/lib/legal/legalAcceptanceService";
import { REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES } from "@/lib/legal/legalDocumentVersions";
import type { SubscriptionRepository } from "@/lib/pricing/pricingService";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";
import { ValidationError } from "@/lib/errors";
import type { BusinessVerificationRepository } from "./businessVerificationRepository";

export interface BusinessActivationStatus {
  active: boolean;
  onboardingComplete: boolean;
  verificationStatus: "not_submitted" | "pending" | "verified" | "rejected" | "review_required";
  subscriptionStatus: "active" | "canceled" | "not_subscribed";
  /** "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 3/8: a FOURTH independent domain fact, mirroring verification/subscription exactly — true only once every REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES has a CURRENT-version acceptance recorded for this organization. */
  legalAcceptanceComplete: boolean;
  /** Human-readable, non-exhaustive reasons the organization is not yet ACTIVE — never shown when `active` is true. */
  reasons: readonly string[];
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 6/Requirement 29: the ONE canonical
 * server-side decision for whether a Business organization is operationally ACTIVE. No route or
 * React component may duplicate this logic — every "is this organization active" check, wherever
 * it is needed, must call `computeActivationStatus`.
 *
 * Deliberately a pure READ, computed fresh every call from three independent domain facts —
 * onboarding progress, verification status, and subscription status — never a stored "isActive"
 * flag that could drift out of sync with any one of them (Requirement 29: "VERIFIED does not mean
 * SUBSCRIPTION ACTIVE" / "SUBSCRIPTION PAID does not mean VERIFIED" — both must independently hold).
 */
export class BusinessActivationService {
  constructor(
    private readonly businessProfiles: BusinessProfileRepository,
    private readonly verifications: BusinessVerificationRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly legalAcceptance: LegalAcceptanceService,
  ) {}

  async computeActivationStatus(organizationId: string): Promise<BusinessActivationStatus> {
    const profile = await this.businessProfiles.findById(organizationId);
    if (!profile) throw new ValidationError("Unknown organization.");

    const [verification, subscription, legalAcceptanceComplete] = await Promise.all([
      this.verifications.findLatestForOrganization(organizationId),
      this.subscriptions.findActiveByProfile("business", organizationId),
      this.legalAcceptance.hasAllCurrentAcceptances(organizationId, REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES),
    ]);

    const onboardingComplete = profile.onboardingStep === "billing_setup_complete";
    const verificationStatus = verification?.status ?? "not_submitted";
    const subscriptionStatus: BusinessActivationStatus["subscriptionStatus"] = subscription ? "active" : "not_subscribed";

    const reasons: string[] = [];
    if (!onboardingComplete) reasons.push("Business onboarding is not yet complete.");
    if (verificationStatus !== "verified") reasons.push("Business verification is not yet complete.");
    if (subscriptionStatus !== "active") reasons.push("This organization has no active Paid2You subscription.");
    if (!legalAcceptanceComplete) reasons.push("Required legal agreements have not yet been accepted.");

    return {
      active: onboardingComplete && verificationStatus === "verified" && subscriptionStatus === "active" && legalAcceptanceComplete,
      onboardingComplete,
      verificationStatus,
      subscriptionStatus,
      legalAcceptanceComplete,
      reasons,
    };
  }
}
