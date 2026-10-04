import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { BusinessOnboardingService } from "@/lib/organizations/businessOnboardingService";
import { getBusinessOnboardingService } from "@/lib/organizations/getBusinessOnboardingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Section 3: server-derived resumability — "a user must resume at the correct incomplete step...
 * persistent progression must be server-derived," never React component state. This is the single
 * read a resuming onboarding UI needs: current step, verification status, subscription, and the
 * independently-computed activation decision.
 */
export function createOnboardingStateHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const organizationId = request.nextUrl.searchParams.get("organizationId");
    if (!organizationId) throw new ValidationError("organizationId is required.");

    const state = await onboarding.getOnboardingState({ actingUserId: userId, organizationId });
    return NextResponse.json(
      {
        organizationId: state.profile.id,
        displayName: state.profile.displayName,
        onboardingStep: state.profile.onboardingStep,
        verification: state.verification ? { status: state.verification.status, reviewRequired: state.verification.reviewRequired } : null,
        subscription: state.subscription ? { status: state.subscription.status, pricingPlanId: state.subscription.pricingPlanId } : null,
        activation: state.activation,
        legalAcceptance: state.legalAcceptance,
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOnboardingStateHandler(getAuthService(), getBusinessOnboardingService())(request);
}

export const GET = withErrorHandling("organizations_onboarding_state", handleGet);
