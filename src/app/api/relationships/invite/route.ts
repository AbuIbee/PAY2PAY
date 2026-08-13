import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipInvitationService } from "@/lib/relationships/relationshipInvitationService";
import { getRelationshipInvitationService } from "@/lib/relationships/getRelationshipInvitationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inviteSchema = z.object({
  actingParty: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }),
  inviteeEmail: z.string().trim().email(),
  inviteeRole: z.enum(["creditor", "debtor"]),
});

/** POST /api/relationships/invite — starts the cooperative handshake. The raw invitation token is deliberately never returned in this response — it is delivered once, only via the invitee's own email (see RelationshipInvitationService's own doc comment). */
export function createRelationshipInviteHandler(authService: AuthService, invitationService: RelationshipInvitationService) {
  return async function handleInvite(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = inviteSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "actingParty, inviteeEmail, and inviteeRole are required.");
    }
    const { relationship, invitation } = await invitationService.createInvitation({
      actingUserId: userId,
      actingParty: parsed.data.actingParty,
      inviteeEmail: parsed.data.inviteeEmail,
      inviteeRole: parsed.data.inviteeRole,
    });
    return NextResponse.json({ relationship, invitation: { id: invitation.id, status: invitation.status, expiresAt: invitation.expiresAt } }, { status: 201 });
  };
}

async function handleInvite(request: NextRequest): Promise<Response> {
  return createRelationshipInviteHandler(getAuthService(), getRelationshipInvitationService())(request);
}

export const POST = withErrorHandling("relationship_invite", handleInvite);
