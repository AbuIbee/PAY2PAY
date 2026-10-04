import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { DrizzleProfileDisplayReader } from "@/lib/documents/drizzleProfileDisplayReader";
import type { ProfileDisplayReader } from "@/lib/documents/profileDisplayReader";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { DrizzleBusinessCustomerRepository } from "@/lib/organizations/drizzleBusinessCustomerRepository";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { BusinessCustomerRepository } from "@/lib/organizations/businessCustomerRepository";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ organizationId: z.string().uuid() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 20: the Business
 * nav's "Customers" page own real data source — BusinessCustomerRepository (Phase 2's pre-existing,
 * tenant-scoped-by-construction customer directory). Fails closed on the canonical
 * `OrganizationPermissionService` ("customers.view"). Display name is best-effort only
 * (ProfileDisplayReader — "never used for authorization"), never the basis for any decision here.
 */
export function createOrganizationCustomersGetHandler(
  authService: AuthService,
  permissions: OrganizationPermissionService,
  customers: BusinessCustomerRepository,
  displayReader: ProfileDisplayReader,
) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");

    const allowed = await permissions.can(userId, parsed.data.organizationId, "customers.view");
    if (!allowed) throw new ForbiddenError("You do not have access to this organization's customers.");

    const records = await customers.listForOrganization(parsed.data.organizationId);
    const items = await Promise.all(
      records.map(async (c) => ({
        id: c.id,
        displayName: await displayReader.getDisplayName(c.counterpartyProfileKind, c.counterpartyProfileId).catch(() => "Name not provided"),
        externalCustomerReference: c.externalCustomerReference,
        status: c.status,
        createdAt: c.createdAt,
      })),
    );
    return NextResponse.json({ items }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOrganizationCustomersGetHandler(getAuthService(), getOrganizationPermissionService(), new DrizzleBusinessCustomerRepository(), new DrizzleProfileDisplayReader())(request);
}

export const GET = withErrorHandling("organizations_customers_get", handleGet);
