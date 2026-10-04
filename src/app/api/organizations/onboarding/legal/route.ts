import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES } from "@/lib/legal/legalDocumentVersions";
import type { BusinessOnboardingService } from "@/lib/organizations/businessOnboardingService";
import { getBusinessOnboardingService } from "@/lib/organizations/getBusinessOnboardingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 3/8: the Business onboarding legal-
 * acceptance step's own read — current required document types, their current version, and whether
 * THIS organization already has a current acceptance for each. Mirrors
 * `/api/organizations/onboarding/plans`'s "read the one canonical source, never a second copy"
 * pattern — `REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES`/`CURRENT_LEGAL_DOCUMENT_VERSIONS` remain
 * the only place these are defined.
 */
export function createOnboardingLegalGetHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const organizationId = request.nextUrl.searchParams.get("organizationId");
    if (!organizationId) throw new ValidationError("organizationId is required.");

    const status = await onboarding.getLegalAcceptanceStatus({ actingUserId: userId, organizationId });
    return NextResponse.json({ documents: status }, { status: 200 });
  };
}

const postSchema = z.object({
  organizationId: z.string().uuid(),
  documentType: z.enum(REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES as [string, ...string[]]),
});

/**
 * Records ONE document's acceptance. Deliberately accepts ONLY `organizationId` + `documentType` from
 * the client — `userId` comes from the authenticated session, `acceptedAt` from the server clock, and
 * `documentVersion` is resolved entirely server-side inside `LegalAcceptanceService`. There is no
 * request field for any of those three, so none of them can ever be spoofed (Section 3/24).
 */
export function createOnboardingLegalPostHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = postSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid organizationId and documentType are required.");

    const record = await onboarding.acceptLegalDocument({ actingUserId: userId, organizationId: parsed.data.organizationId, documentType: parsed.data.documentType });
    return NextResponse.json({ documentType: record.documentType, documentVersion: record.documentVersion, acceptedAt: record.acceptedAt.toISOString() }, { status: 201 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createOnboardingLegalGetHandler(getAuthService(), getBusinessOnboardingService())(request);
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createOnboardingLegalPostHandler(getAuthService(), getBusinessOnboardingService())(request);
}

export const GET = withErrorHandling("organizations_onboarding_legal_get", handleGet);
export const POST = withErrorHandling("organizations_onboarding_legal_post", handlePost);
