import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getServerEnv } from "@/config/env";
import { ValidationError } from "@/lib/errors";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import { getPlatformBillingService } from "@/lib/organizations/getPlatformBillingService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import type { PlatformBillingService } from "@/lib/organizations/platformBillingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ organizationId: z.string().uuid() });

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 29: Change Payment Method — redirects the billing
 * administrator to the provider's own hosted experience (Stripe Billing Portal) rather than this
 * application ever rendering a raw card-entry form. Returns a 503/`ProviderNotAvailableError` (via
 * `getPlatformBillingService`'s lazy provider resolution — see that factory's own doc comment) when
 * no live billing provider is configured, and a plain 400/`ValidationError` when the organization has
 * no provider customer relationship yet (billing was never set up) — never a fabricated hosted URL.
 */
export function createOrganizationBillingPaymentMethodHandler(authService: AuthService, permissions: OrganizationPermissionService, getBillingService: () => PlatformBillingService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid organizationId is required.");

    await permissions.require(userId, parsed.data.organizationId, "subscription.manage");
    const returnUrl = `${getServerEnv().APP_URL}/organizations/${parsed.data.organizationId}/settings/billing`;
    const session = await getBillingService().createPaymentMethodUpdateSession(parsed.data.organizationId, returnUrl);
    return NextResponse.json({ hostedUrl: session.hostedUrl }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createOrganizationBillingPaymentMethodHandler(getAuthService(), getOrganizationPermissionService(), () => getPlatformBillingService())(request);
}

export const POST = withErrorHandling("organizations_billing_payment_method", handlePost);
