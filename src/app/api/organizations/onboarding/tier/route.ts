import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { BusinessOnboardingService } from "@/lib/organizations/businessOnboardingService";
import { getBusinessOnboardingService } from "@/lib/organizations/getBusinessOnboardingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().uuid(),
  planCode: z.string().trim().min(1).max(100),
});

/** Requirement 4/Section 4: tier selection — plan validity is PricingService's own (never duplicated here). */
export function createOnboardingTierHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handleSubmit(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid plan code is required.");
    }

    const subscription = await onboarding.selectTier({ actingUserId: userId, organizationId: parsed.data.organizationId, planCode: parsed.data.planCode });
    return NextResponse.json({ pricingPlanId: subscription.pricingPlanId, status: subscription.status }, { status: 201 });
  };
}

async function handleSubmit(request: NextRequest): Promise<Response> {
  return createOnboardingTierHandler(getAuthService(), getBusinessOnboardingService())(request);
}

export const POST = withErrorHandling("organizations_onboarding_tier", handleSubmit);
