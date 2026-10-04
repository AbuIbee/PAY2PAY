import "server-only";
import { getLegalAcceptanceService } from "@/lib/legal/getLegalAcceptanceService";
import { getPricingService } from "@/lib/pricing/getPricingService";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";
import { getBusinessProfileService } from "@/lib/profiles/getBusinessProfileService";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { DrizzleBusinessStaffMemberRepository } from "@/lib/staff/drizzleBusinessStaffMemberRepository";
import { BusinessOnboardingService } from "./businessOnboardingService";
import { DrizzleBusinessVerificationRepository } from "./drizzleBusinessVerificationRepository";
import { getBusinessActivationService } from "./getBusinessActivationService";
import { getBusinessVerificationService } from "./getBusinessVerificationService";
import { getOrganizationRoleService } from "./getOrganizationRoleService";
import { getPlatformBillingService } from "./getPlatformBillingService";

let cached: BusinessOnboardingService | null = null;

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 2/3: wires BusinessOnboardingService against
 * real Drizzle repositories and the real production service factories. `getBusinessVerificationService`/
 * `getPlatformBillingService` are passed as THUNKS (`() => ...`), never called here — see
 * BusinessOnboardingService's own constructor doc comment for why calling them eagerly would make
 * constructing this whole service fail whenever either provider is unconfigured.
 */
export function getBusinessOnboardingService(): BusinessOnboardingService {
  if (!cached) {
    cached = new BusinessOnboardingService(
      new DrizzleBusinessProfileRepository(),
      getBusinessProfileService(),
      new DrizzleBusinessStaffMemberRepository(),
      getOrganizationRoleService(),
      () => getBusinessVerificationService(),
      new DrizzleBusinessVerificationRepository(),
      getPricingService(),
      new DrizzleSubscriptionRepository(),
      () => getPlatformBillingService(),
      getBusinessActivationService(),
      getLegalAcceptanceService(),
    );
  }
  return cached;
}
