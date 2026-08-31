import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementInvitationService } from "@/lib/agreementInvitations/agreementInvitationService";
import { getAgreementInvitationService } from "@/lib/agreementInvitations/getAgreementInvitationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCEPT_LIMIT_PER_USER = 30;
const ACCEPT_WINDOW_MS = 60 * 60 * 1000;

const acceptSchema = z.object({
  token: z.string().trim().min(1),
  actingProfile: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }).optional(),
});

/**
 * POST /api/agreement-invitations/accept — requires authentication (this PRSprint's own "Formal
 * Accept/Counter requires verified identity/account"). Finalizes the current proposed terms into a
 * real agreement — see AgreementInvitationService.acceptPlan's own doc comment for the full state-
 * machine walk. Returns the new agreementId so the client can "return the user directly to the
 * agreement" (never a generic dashboard), plus `connectionRequired` — always `false` on a fully
 * normal accept; `true` only in the rare case acceptance itself succeeded (status 200, never a 500
 * that would invite a full retry) but connection establishment didn't — the agreement page's own
 * existing "Connection required" progress step and MissingConnectionPanel are the recovery path,
 * not a second call to this route (the invitation is already consumed).
 */
export function createAgreementInvitationAcceptHandler(authService: AuthService, invitationService: AgreementInvitationService) {
  return async function handleAccept(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = acceptSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid token is required.");

    if (!(await checkRateLimit(`agreement-invitation-accept:user:${userId}`, ACCEPT_LIMIT_PER_USER, ACCEPT_WINDOW_MS))) {
      throw new RateLimitedError("Too many attempts. Please try again later.");
    }

    const result = await invitationService.acceptPlan({
      rawToken: parsed.data.token,
      actingUserId: userId,
      actingProfile: parsed.data.actingProfile,
    });
    return NextResponse.json(result, { status: 200 });
  };
}

async function handleAccept(request: NextRequest): Promise<Response> {
  return createAgreementInvitationAcceptHandler(getAuthService(), getAgreementInvitationService())(request);
}

export const POST = withErrorHandling("agreement_invitation_accept", handleAccept);
