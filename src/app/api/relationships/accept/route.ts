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

const acceptSchema = z.object({
  invitationId: z.string().uuid(),
  actingParty: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }),
  rawToken: z.string().min(1).optional(),
});

/** POST /api/relationships/accept — requires the caller be either the invitation's already-resolved invitee or present rawToken (the one-time secret from the invitee's own email) — see RelationshipInvitationService.acceptInvitation. */
export function createRelationshipAcceptHandler(authService: AuthService, invitationService: RelationshipInvitationService) {
  return async function handleAccept(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = acceptSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "invitationId and actingParty are required.");
    }
    const relationship = await invitationService.acceptInvitation({
      invitationId: parsed.data.invitationId,
      actingUserId: userId,
      actingParty: parsed.data.actingParty,
      rawToken: parsed.data.rawToken,
    });
    return NextResponse.json({ relationship }, { status: 200 });
  };
}

async function handleAccept(request: NextRequest): Promise<Response> {
  return createRelationshipAcceptHandler(getAuthService(), getRelationshipInvitationService())(request);
}

export const POST = withErrorHandling("relationship_accept", handleAccept);
