import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { BUSINESS_INDUSTRY_VALUES } from "@/lib/organizations/businessIndustryLabels";
import type { BusinessOnboardingService } from "@/lib/organizations/businessOnboardingService";
import { getBusinessOnboardingService } from "@/lib/organizations/getBusinessOnboardingService";
import { getWorkspaceContextService } from "@/lib/organizations/getWorkspaceContextService";
import type { WorkspaceContextService } from "@/lib/organizations/workspaceContext";
import { US_STATE_CODES } from "@/lib/us-states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().optional(),
  city: z.string().trim().min(1),
  state: z.enum(US_STATE_CODES),
  postalCode: z.string().trim().min(1),
});

const representativeSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  phone: z.string().trim().min(7).max(20),
  relationshipToBusiness: z.string().trim().min(1).max(100),
});

/** Requirement 3/Section 2: the Business Details onboarding step. */
const businessDetailsSchema = z.object({
  organizationId: z.string().uuid().nullable().optional(),
  legalBusinessName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  entityType: z.string().trim().min(1).max(100),
  dbaName: z.string().trim().max(200).optional(),
  industry: z.enum(BUSINESS_INDUSTRY_VALUES as unknown as [string, ...string[]]),
  formationJurisdiction: z.string().trim().min(1).max(100),
  businessAddress: addressSchema,
  businessEmail: z.string().trim().email(),
  businessPhone: z.string().trim().min(7).max(20).optional(),
  website: z.string().trim().url().optional(),
  country: z.string().trim().length(2).default("US"),
  state: z.enum(US_STATE_CODES),
  representative: representativeSchema,
});

export function createOrganizationsListHandler(authService: AuthService, workspaceContext: WorkspaceContextService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const organizations = await workspaceContext.listWorkspacesForUser(userId);
    return NextResponse.json({ organizations }, { status: 200 });
  };
}

export function createOrganizationsCreateHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = businessDetailsSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Valid business details are required.");
    }

    const profile = await onboarding.submitBusinessDetails({
      actingUserId: userId,
      organizationId: parsed.data.organizationId ?? null,
      legalBusinessName: parsed.data.legalBusinessName,
      displayName: parsed.data.displayName,
      entityType: parsed.data.entityType,
      dbaName: parsed.data.dbaName ?? null,
      industry: parsed.data.industry as "TRUCKING" | "FREIGHT" | "THREE_PL" | "RETAIL" | "OTHER",
      formationJurisdiction: parsed.data.formationJurisdiction,
      businessAddress: parsed.data.businessAddress,
      businessEmail: parsed.data.businessEmail,
      businessPhone: parsed.data.businessPhone ?? null,
      website: parsed.data.website ?? null,
      country: parsed.data.country,
      state: parsed.data.state,
      representative: parsed.data.representative,
    });

    return NextResponse.json(
      { organizationId: profile.id, displayName: profile.displayName, onboardingStep: profile.onboardingStep },
      { status: 201 },
    );
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createOrganizationsListHandler(getAuthService(), getWorkspaceContextService())(request);
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createOrganizationsCreateHandler(getAuthService(), getBusinessOnboardingService())(request);
}

export const GET = withErrorHandling("organizations_list", handleList);
export const POST = withErrorHandling("organizations_create", handleCreate);
