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

/** GET /api/relationships/evidence/signed-url?relationshipId=...&evidenceId=... — relationship-participation gate, then Sprint 7's own evidence-visibility re-check inside getSignedEvidenceUrl itself. */
export function createRelationshipEvidenceSignedUrlHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleSignedUrl(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const relationshipId = searchParams.get("relationshipId");
    const evidenceId = searchParams.get("evidenceId");
    if (!relationshipId || !evidenceId) throw new ValidationError("relationshipId and evidenceId are required.");

    const signedUrl = await relationshipService.getRelationshipEvidenceSignedUrl(relationshipId, evidenceId, userId);
    return NextResponse.json({ signedUrl }, { status: 200 });
  };
}

async function handleSignedUrl(request: NextRequest): Promise<Response> {
  return createRelationshipEvidenceSignedUrlHandler(getAuthService(), getRelationshipService())(request);
}

export const GET = withErrorHandling("relationship_evidence_signed_url", handleSignedUrl);
