import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { businessIndustryLabel } from "@/lib/organizations/businessIndustryLabels";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";
import { getPricingService } from "@/lib/pricing/getPricingService";
import type { PricingService } from "@/lib/pricing/pricingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ organizationId: z.string().uuid() });

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 20: the Business
 * nav's "Organization Settings" page own real data source — a read-only view of the organization's
 * existing BusinessProfileRecord plus its active Paid2You subscription plan (if any). Gated behind
 * the canonical `OrganizationPermissionService` ("organization.view") — legacy-equivalent to the prior
 * `manage_organization_settings` capability (OWNER-only among the five legacy roles; ordinary VIEWER
 * and FINANCE_ADMIN are both correctly denied, matching old behavior exactly). No edit capability is
 * implemented here — read only, matching Step 14's "stop after this phase" scope boundary.
 */
export function createOrganizationSettingsGetHandler(authService: AuthService, permissions: OrganizationPermissionService, businessProfiles: BusinessProfileRepository, pricing: PricingService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ organizationId: url.searchParams.get("organizationId") });
    if (!parsed.success) throw new ValidationError("A valid organizationId is required.");

    const allowed = await permissions.can(userId, parsed.data.organizationId, "organization.view");
    if (!allowed) throw new ForbiddenError("You do not have access to this organization's settings.");

    const profile = await businessProfiles.findById(parsed.data.organizationId);
    if (!profile) throw new ValidationError("Unknown organization.");

    const activePlan = await pricing.getActivePlan("business", profile.id);
    return NextResponse.json(
      {
        organizationId: profile.id,
        legalBusinessName: profile.legalBusinessName,
        displayName: profile.displayName,
        dbaName: profile.dbaName,
        entityType: profile.entityType,
        industry: profile.industry ? businessIndustryLabel(profile.industry) : null,
        formationJurisdiction: profile.formationJurisdiction,
        businessAddress: profile.businessAddress,
        businessEmail: profile.businessEmail,
        website: profile.website,
        status: profile.status,
        plan: activePlan ? { code: activePlan.code, name: activePlan.name, monthlyFeeMinorUnits: activePlan.monthlyFeeMinorUnits } : null,
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOrganizationSettingsGetHandler(getAuthService(), getOrganizationPermissionService(), new DrizzleBusinessProfileRepository(), getPricingService())(request);
}

export const GET = withErrorHandling("organizations_settings_get", handleGet);
