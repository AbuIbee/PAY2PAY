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

const RESEND_LIMIT_PER_USER = 10;
const RESEND_WINDOW_MS = 60 * 60 * 1000;

const resendSchema = z.object({ invitationId: z.string().uuid() });

/**
 * POST /api/agreement-invitations/resend — sender-only. "Resend is safe": the old token is
 * invalidated the instant a new one is issued (AgreementInvitationService.resendInvitation
 * replaces tokenHash in place, it does not add a second valid token), so there is never more than
 * one working link outstanding.
 */
export function createAgreementInvitationResendHandler(authService: AuthService, invitationService: AgreementInvitationService) {
  return async function handleResend(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = resendSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("invitationId is required.");

    if (!(await checkRateLimit(`agreement-invitation-resend:user:${userId}`, RESEND_LIMIT_PER_USER, RESEND_WINDOW_MS))) {
      throw new RateLimitedError("Too many resend attempts. Please try again later.");
    }

    const { invitation, rawToken, link } = await invitationService.resendInvitation(parsed.data.invitationId, userId);
    return NextResponse.json({ id: invitation.id, status: invitation.status, expiresAt: invitation.expiresAt, rawToken, link }, { status: 200 });
  };
}

async function handleResend(request: NextRequest): Promise<Response> {
  return createAgreementInvitationResendHandler(getAuthService(), getAgreementInvitationService())(request);
}

export const POST = withErrorHandling("agreement_invitation_resend", handleResend);
