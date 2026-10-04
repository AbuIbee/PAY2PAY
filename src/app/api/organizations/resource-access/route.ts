import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { isPermissionKey } from "@/lib/organizations/permissionCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  organizationId: z.string().uuid(),
  permission: z.string().min(1).max(100).refine(isPermissionKey, { message: "Unrecognized permission key." }),
});

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 20: a thin HTTP
 * wrapper over the canonical `OrganizationPermissionService.can` — no new authorization decision is
 * invented here. Used by the Business-nav pages that have no dedicated data route of their own (an
 * honest empty/unavailable state for a feature that isn't built yet — payments, reports,
 * reconciliation, documents, audit history, integrations) but still must not reveal even that empty
 * state to a member who lacks the specific permission key the route itself would require. Pages with
 * real data (balances, customers, employees, settings, agreements) instead perform this exact same
 * check inline in their own data route and never call this endpoint.
 */
export function createResourceAccessGetHandler(authService: AuthService, permissions: OrganizationPermissionService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      organizationId: url.searchParams.get("organizationId"),
      permission: url.searchParams.get("permission"),
    });
    if (!parsed.success) throw new ValidationError("A valid organizationId and permission key are required.");

    const allowed = await permissions.can(userId, parsed.data.organizationId, parsed.data.permission);
    return NextResponse.json({ allowed }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createResourceAccessGetHandler(getAuthService(), getOrganizationPermissionService())(request);
}

export const GET = withErrorHandling("organizations_resource_access", handleGet);
