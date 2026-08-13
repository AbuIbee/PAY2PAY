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
 * GET /api/relationships/evidence?relationshipId=... — document/evidence connector (Phase 25):
 * resolves the relationship's governing agreement and returns exactly what Sprint 7's own
 * EvidenceService.listEvidence would return for that agreement and caller — no duplicate storage or
 * visibility logic here, see RelationshipService.getRelationshipEvidence's own doc comment.
 */
export function createRelationshipEvidenceHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleEvidence(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const relationshipId = new URL(request.url).searchParams.get("relationshipId");
    if (!relationshipId) throw new ValidationError("relationshipId is required.");

    const items = await relationshipService.getRelationshipEvidence(relationshipId, userId);
    return NextResponse.json(
      {
        evidence: items.map((item) => ({
          id: item.id,
          uploadedByUserId: item.uploadedByUserId,
          documentType: item.documentType,
          description: item.description,
          fileSizeBytes: item.fileSizeBytes,
          contentType: item.contentType,
          isPostSigning: item.isPostSigning,
          visibility: item.visibility,
          sharedWithWitnesses: item.sharedWithWitnesses,
          disputeFlag: item.disputeFlag,
          withdrawalState: item.withdrawalState,
          uploadedAt: item.uploadedAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleEvidence(request: NextRequest): Promise<Response> {
  return createRelationshipEvidenceHandler(getAuthService(), getRelationshipService())(request);
}

export const GET = withErrorHandling("relationship_evidence_list", handleEvidence);
