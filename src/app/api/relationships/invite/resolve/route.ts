import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getRelationshipInvitationService } from "@/lib/relationships/getRelationshipInvitationService";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/relationships/invite/resolve?token=... — deliberately unauthenticated: this is the one
 * deep-link an invitee opens *before* they may have an account. Read-only and safe by construction —
 * see RelationshipInvitationService.resolveInvitationByToken's own doc comment for exactly what it
 * does and does not reveal (never more than invitation id/relationship id/email/role, and only while
 * the invitation is still open and unexpired).
 */
async function handleResolve(request: NextRequest): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw new ValidationError("token is required.");
  const result = await getRelationshipInvitationService().resolveInvitationByToken(token);
  if (!result) {
    return NextResponse.json({ found: false }, { status: 200 });
  }
  return NextResponse.json({ found: true, ...result }, { status: 200 });
}

export const GET = withErrorHandling("relationship_invite_resolve", handleResolve);
