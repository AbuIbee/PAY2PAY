import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementInvitationService } from "@/lib/agreementInvitations/agreementInvitationService";
import { getAgreementInvitationService } from "@/lib/agreementInvitations/getAgreementInvitationService";
import { termsRequestSchema, toDraftTermsInput } from "@/lib/agreementInvitations/termsRequestSchema";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROPOSE_LIMIT_PER_USER = 30;
const PROPOSE_WINDOW_MS = 60 * 60 * 1000;

const proposeSchema = z.object({
  token: z.string().trim().min(1),
  actingProfile: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }).optional(),
  message: z.string().trim().max(1000).optional(),
  terms: termsRequestSchema,
});

/**
 * POST /api/agreement-invitations/propose — "Request Changes" (recipient) or a further counter
 * (sender). Requires authentication either way — this PRSprint's own "Anonymous user may draft
 * intent but not mutate active terms. Identity verification/account creation is required before
 * formal submission." See AgreementInvitationService.proposeTerms's own doc comment for why one
 * method serves both directions.
 */
export function createAgreementInvitationProposeHandler(authService: AuthService, invitationService: AgreementInvitationService) {
  return async function handlePropose(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = proposeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid token and terms are required.");
    }

    if (!(await checkRateLimit(`agreement-invitation-propose:user:${userId}`, PROPOSE_LIMIT_PER_USER, PROPOSE_WINDOW_MS))) {
      throw new RateLimitedError("Too many attempts. Please try again later.");
    }

    const invitation = await invitationService.proposeTerms({
      rawToken: parsed.data.token,
      actingUserId: userId,
      actingProfile: parsed.data.actingProfile,
      terms: toDraftTermsInput(parsed.data.terms),
      message: parsed.data.message,
    });
    return NextResponse.json({ id: invitation.id, proposalVersion: invitation.proposalVersion, status: invitation.status }, { status: 200 });
  };
}

async function handlePropose(request: NextRequest): Promise<Response> {
  return createAgreementInvitationProposeHandler(getAuthService(), getAgreementInvitationService())(request);
}

export const POST = withErrorHandling("agreement_invitation_propose", handlePropose);
