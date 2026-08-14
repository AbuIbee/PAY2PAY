import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipService } from "@/lib/relationships/relationshipService";
import { getRelationshipService } from "@/lib/relationships/getRelationshipService";
import type { RelationshipInvitationService } from "@/lib/relationships/relationshipInvitationService";
import { getRelationshipInvitationService } from "@/lib/relationships/getRelationshipInvitationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 18B: thin route over RelationshipInvitationService.listInvitationsForRelationship, which
 * existed with no route (used only internally). Needed for the Connections UI's "sent invitations"
 * list and to resolve an invitationId for the cancel action. Authorization is delegated to
 * RelationshipService.getRelationship (participant-only), same gate the /activate/check route
 * already uses for the identical "confirm caller belongs to this relationship first" pattern —
 * RelationshipInvitationService itself has no participant-resolution method of its own.
 */
export function createRelationshipInvitationsListHandler(
  authService: AuthService,
  relationshipService: RelationshipService,
  invitationService: RelationshipInvitationService,
) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const relationshipId = new URL(request.url).searchParams.get("relationshipId");
    if (!relationshipId) throw new ValidationError("relationshipId is required.");
    await relationshipService.getRelationship(relationshipId, userId);
    const invitations = await invitationService.listInvitationsForRelationship(relationshipId);
    return NextResponse.json({ invitations }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createRelationshipInvitationsListHandler(getAuthService(), getRelationshipService(), getRelationshipInvitationService())(request);
}

export const GET = withErrorHandling("relationship_invitations_list", handleList);
