import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipInvitationService } from "@/lib/relationships/relationshipInvitationService";
import { getRelationshipInvitationService } from "@/lib/relationships/getRelationshipInvitationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): mirrors
// staff/invite's rate limiting — per-inviter (generic abuse) and per-target-email (spam against the
// invited party, regardless of which account is doing the inviting).
const INVITE_LIMIT_PER_INVITER = 20;
const INVITE_LIMIT_PER_TARGET_EMAIL = 5;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

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

    if (!(await checkRateLimit(`relationship-invite:inviter:${userId}`, INVITE_LIMIT_PER_INVITER, INVITE_WINDOW_MS))) {
      throw new RateLimitedError("Too many invitations sent. Please try again later.");
    }
    if (
      !(await checkRateLimit(
        `relationship-invite:target:${parsed.data.inviteeEmail.toLowerCase()}`,
        INVITE_LIMIT_PER_TARGET_EMAIL,
        INVITE_WINDOW_MS,
      ))
    ) {
      throw new RateLimitedError("This person has already been invited too many times recently.");
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
