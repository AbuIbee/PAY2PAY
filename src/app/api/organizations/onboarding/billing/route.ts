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
  billingEmail: z.string().trim().email(),
  // Opaque token from a provider-hosted payment component — never raw card/bank data (see
  // PlatformBillingProvider's own doc comment).
  paymentMethodToken: z.string().trim().min(1).max(500),
});

/**
 * Requirement 4/Section 5: production billing is currently NOT_CONFIGURED (PlatformBillingProvider)
 * — BusinessOnboardingService.setUpBilling lets that `ProviderNotAvailableError` propagate directly;
 * withErrorHandling turns it into a 503 ("Billing setup unavailable / provider not configured"),
 * never a fabricated "payment completed" response. Onboarding progress made so far is untouched
 * either way (see that method's own doc comment).
 */
export function createOnboardingBillingHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handleSubmit(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid billing email and payment method are required.");
    }

    const summary = await onboarding.setUpBilling({
      actingUserId: userId,
      organizationId: parsed.data.organizationId,
      billingEmail: parsed.data.billingEmail,
      paymentMethodToken: parsed.data.paymentMethodToken,
    });
    return NextResponse.json(
      {
        subscriptionStatus: summary.subscription.status,
        currentPeriodEnd: summary.subscription.currentPeriodEnd,
        paymentMethod: summary.paymentMethod ? { displayLast4: summary.paymentMethod.displayLast4, paymentType: summary.paymentMethod.paymentType } : null,
      },
      { status: 201 },
    );
  };
}

async function handleSubmit(request: NextRequest): Promise<Response> {
  return createOnboardingBillingHandler(getAuthService(), getBusinessOnboardingService())(request);
}

export const POST = withErrorHandling("organizations_onboarding_billing", handleSubmit);
