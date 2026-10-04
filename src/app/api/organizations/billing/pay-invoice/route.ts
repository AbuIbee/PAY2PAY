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

const schema = z.object({ organizationId: z.string().uuid(), invoiceId: z.string().uuid() });

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 10/11: "Pay Now" for a past-due/open
 * invoice. `getBillingService` is a THUNK, resolved only after the permission check, so a
 * NOT_CONFIGURED provider surfaces as the existing, honest `ProviderNotAvailableError` (503) — never a
 * fabricated success.
 */
export function createOrganizationBillingPayInvoiceHandler(authService: AuthService, permissions: OrganizationPermissionService, getBillingService: () => PlatformBillingService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid organizationId and invoiceId are required.");

    await permissions.require(userId, parsed.data.organizationId, "subscription.manage");
    const invoice = await getBillingService().payInvoice(parsed.data.organizationId, parsed.data.invoiceId);
    return NextResponse.json({ id: invoice.id, status: invoice.status, paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createOrganizationBillingPayInvoiceHandler(getAuthService(), getOrganizationPermissionService(), () => getPlatformBillingService())(request);
}

export const POST = withErrorHandling("organizations_billing_pay_invoice", handlePost);
