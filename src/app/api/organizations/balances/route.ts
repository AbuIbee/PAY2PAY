import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { DrizzleBusinessObligationRepository } from "@/lib/organizations/drizzleBusinessObligationRepository";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { BusinessObligationRepository } from "@/lib/organizations/businessObligationRepository";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ organizationId: z.string().uuid() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 20: the Business
 * nav's "Outstanding Balances" page own real data source — BusinessObligationRepository (Phase 2's
 * pre-existing, tenant-scoped-by-construction obligation ledger). Fails closed on the canonical
 * `OrganizationPermissionService` ("balances.view") — never `canReadOrganizationResource` (the prior
 * phase's transitional capability boundary) and never membership alone.
 */
export function createOrganizationBalancesGetHandler(authService: AuthService, permissions: OrganizationPermissionService, obligations: BusinessObligationRepository) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");

    const allowed = await permissions.can(userId, parsed.data.organizationId, "balances.view");
    if (!allowed) throw new ForbiddenError("You do not have access to this organization's balances.");

    const items = await obligations.listForOrganization(parsed.data.organizationId);
    return NextResponse.json(
      {
        items: items.map((o) => ({
          id: o.id,
          customerId: o.customerId,
          agreementId: o.agreementId,
          invoiceReference: o.invoiceReference,
          originalAmountMinorUnits: o.originalAmountMinorUnits,
          agreedAmountMinorUnits: o.agreedAmountMinorUnits,
          status: o.status,
          createdAt: o.createdAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOrganizationBalancesGetHandler(getAuthService(), getOrganizationPermissionService(), new DrizzleBusinessObligationRepository())(request);
}

export const GET = withErrorHandling("organizations_balances_get", handleGet);
