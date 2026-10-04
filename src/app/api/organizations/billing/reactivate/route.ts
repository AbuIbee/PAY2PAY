import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import { getPlatformBillingService } from "@/lib/organizations/getPlatformBillingService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import type { PlatformBillingService } from "@/lib/organizations/platformBillingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ organizationId: z.string().uuid() });

/** Requirement 25: reactivating a cancel-at-period-end (not yet lapsed) subscription — local-first, same as cancel. */
export function createOrganizationBillingReactivateHandler(authService: AuthService, permissions: OrganizationPermissionService, getBillingService: () => PlatformBillingService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid organizationId is required.");

    await permissions.require(userId, parsed.data.organizationId, "subscription.manage");
    const subscription = await getBillingService().reactivate(parsed.data.organizationId);
    return NextResponse.json({ status: subscription.status, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createOrganizationBillingReactivateHandler(getAuthService(), getOrganizationPermissionService(), () => getPlatformBillingService())(request);
}

export const POST = withErrorHandling("organizations_billing_reactivate", handlePost);
