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

const cancelSchema = z.object({ invitationId: z.string().uuid() });

export function createRelationshipInviteCancelHandler(authService: AuthService, invitationService: RelationshipInvitationService) {
  return async function handleCancel(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = cancelSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "invitationId is required.");
    }
    const invitation = await invitationService.cancelInvitation({ invitationId: parsed.data.invitationId, actingUserId: userId });
    return NextResponse.json({ invitation }, { status: 200 });
  };
}

async function handleCancel(request: NextRequest): Promise<Response> {
  return createRelationshipInviteCancelHandler(getAuthService(), getRelationshipInvitationService())(request);
}

export const POST = withErrorHandling("relationship_invite_cancel", handleCancel);
