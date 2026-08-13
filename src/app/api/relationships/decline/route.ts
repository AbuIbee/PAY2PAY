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

const declineSchema = z.object({ invitationId: z.string().uuid(), rawToken: z.string().min(1).optional() });

export function createRelationshipDeclineHandler(authService: AuthService, invitationService: RelationshipInvitationService) {
  return async function handleDecline(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = declineSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "invitationId is required.");
    }
    const invitation = await invitationService.declineInvitation({
      invitationId: parsed.data.invitationId,
      actingUserId: userId,
      rawToken: parsed.data.rawToken,
    });
    return NextResponse.json({ invitation }, { status: 200 });
  };
}

async function handleDecline(request: NextRequest): Promise<Response> {
  return createRelationshipDeclineHandler(getAuthService(), getRelationshipInvitationService())(request);
}

export const POST = withErrorHandling("relationship_decline", handleDecline);
