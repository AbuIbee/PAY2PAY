import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipService } from "@/lib/relationships/relationshipService";
import { getRelationshipService } from "@/lib/relationships/getRelationshipService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Missing-connection remediation (mandatory command): GET /api/agreements/link-candidates?agreementId=
 * — the acting party's own already-existing connections that could legitimately be linked to this
 * agreement via the pre-existing POST /api/relationships/link-agreement (the "Choose Existing
 * Connection" picker's data source). See RelationshipService.listEligibleForAgreementLink's own doc
 * comment for the eligibility rule.
 */
export function createAgreementLinkCandidatesHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");
    const relationships = await relationshipService.listEligibleForAgreementLink(agreementId, userId);
    return NextResponse.json({ relationships }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAgreementLinkCandidatesHandler(getAuthService(), getRelationshipService())(request);
}

export const GET = withErrorHandling("agreement_link_candidates", handleGet);
