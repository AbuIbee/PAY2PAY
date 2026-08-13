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

/** GET /api/relationships/activate/check?relationshipId=... — the "Relationship Setup Progress" read: explicit, machine-readable eligibility reasons, never a UI-only checklist (Phase 13's own instruction). Confirms the caller is a participant (via getRelationship) before returning gate detail. */
export function createRelationshipActivationCheckHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleCheck(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const relationshipId = new URL(request.url).searchParams.get("relationshipId");
    if (!relationshipId) throw new ValidationError("relationshipId is required.");
    await relationshipService.getRelationship(relationshipId, userId);
    const result = await relationshipService.checkActivationPrerequisites(relationshipId);
    return NextResponse.json(result, { status: 200 });
  };
}

async function handleCheck(request: NextRequest): Promise<Response> {
  return createRelationshipActivationCheckHandler(getAuthService(), getRelationshipService())(request);
}

export const GET = withErrorHandling("relationship_activate_check", handleCheck);
