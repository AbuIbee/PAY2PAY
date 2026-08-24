import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipInvitationService } from "@/lib/relationships/relationshipInvitationService";
import { getRelationshipInvitationService } from "@/lib/relationships/getRelationshipInvitationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Closed-beta remediation (DEF-UAT-006): the caller's own pending received invitations — self-scoped
 * from the session, never accepted as a request parameter, mirroring every other "my own X" route in
 * this codebase (e.g. /api/notifications). Backs the "Pending invitations" section on
 * /connections/invitations, which previously had no list endpoint to call at all.
 */
export function createRelationshipInvitationsPendingListHandler(authService: AuthService, invitationService: RelationshipInvitationService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const invitations = await invitationService.listPendingForInvitee(userId);
    return NextResponse.json({ invitations }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createRelationshipInvitationsPendingListHandler(getAuthService(), getRelationshipInvitationService())(request);
}

export const GET = withErrorHandling("relationship_invitations_pending_list", handleList);
