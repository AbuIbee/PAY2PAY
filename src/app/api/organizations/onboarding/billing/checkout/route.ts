import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getServerEnv } from "@/config/env";
import { ValidationError } from "@/lib/errors";
import type { BusinessOnboardingService } from "@/lib/organizations/businessOnboardingService";
import { getBusinessOnboardingService } from "@/lib/organizations/getBusinessOnboardingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().uuid(),
  billingEmail: z.string().trim().email(),
});

/**
 * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7/8-D/9/10: the real hosted-
 * checkout initial-billing entry point. Returns a provider-hosted URL the client redirects the
 * Business to — this application never collects a provider PaymentMethod id directly. `successUrl`/
 * `cancelUrl` are SERVER-derived from `APP_URL` (never accepted from the client — Section 9's own
 * "the server derives trusted references," applied here to the redirect targets too, which also
 * closes off any open-redirect risk). The redirect itself proves nothing (Section 10) — only a
 * verified `checkout.session.completed` webhook (`PlatformBillingWebhookService`) ever marks anything
 * active; this handler's own 201 response carries no activation claim, only the URL to redirect to.
 */
export function createOnboardingBillingCheckoutHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handleSubmit(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid organizationId and billing email are required.");
    }

    const appUrl = getServerEnv().APP_URL;
    const session = await onboarding.beginHostedCheckout({
      actingUserId: userId,
      organizationId: parsed.data.organizationId,
      billingEmail: parsed.data.billingEmail,
      successUrl: `${appUrl}/organizations/${parsed.data.organizationId}/onboarding?billing=success`,
      cancelUrl: `${appUrl}/organizations/${parsed.data.organizationId}/onboarding?billing=canceled`,
    });
    return NextResponse.json({ hostedUrl: session.hostedUrl }, { status: 201 });
  };
}

async function handleSubmit(request: NextRequest): Promise<Response> {
  return createOnboardingBillingCheckoutHandler(getAuthService(), getBusinessOnboardingService())(request);
}

export const POST = withErrorHandling("organizations_onboarding_billing_checkout", handleSubmit);
