import "server-only";
import type { BusinessOnboardingStep, BusinessProfileRepository } from "@/lib/profiles/businessProfileService";

/**
 * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7: extracted out of
 * `BusinessOnboardingService`'s own private `STEP_ORDER`/`stepIndex`/`advanceStep` so the webhook-
 * driven hosted-checkout completion path (`PlatformBillingWebhookService`) can advance the SAME
 * monotonic onboarding step without duplicating this ordering logic — never a second, competing
 * step sequence. Behavior is byte-identical to the pre-existing private implementation this replaces
 * inside `BusinessOnboardingService` (same array, same comparison, same "never regress" guarantee).
 */
export const BUSINESS_ONBOARDING_STEP_ORDER: readonly BusinessOnboardingStep[] = ["details_pending", "details_complete", "verification_submitted", "tier_selected", "billing_setup_complete"];

export function businessOnboardingStepIndex(step: BusinessOnboardingStep): number {
  return BUSINESS_ONBOARDING_STEP_ORDER.indexOf(step);
}

/** Monotonic — a step may only ever advance forward, and a redundant call with the same/earlier step is a safe no-op. */
export async function advanceBusinessOnboardingStepIfNeeded(businessProfiles: BusinessProfileRepository, organizationId: string, current: BusinessOnboardingStep, next: BusinessOnboardingStep): Promise<void> {
  if (businessOnboardingStepIndex(next) <= businessOnboardingStepIndex(current)) return;
  await businessProfiles.setOnboardingStep(organizationId, next);
}
