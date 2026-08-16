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

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md) precedent,
// mirroring relationships/invite's own per-inviter + per-target-contact pair.
const INVITE_LIMIT_PER_INVITER = 20;
const INVITE_LIMIT_PER_TARGET = 5;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

const createSchema = z.object({
  inviterProfile: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }),
  inviterRole: z.enum(["creditor", "debtor"]),
  recipientName: z.string().trim().max(200).optional(),
  recipientEmail: z.string().trim().email().max(254).optional(),
  recipientPhone: z.string().trim().max(32).optional(),
  currency: z.string().trim().length(3).optional(),
  message: z.string().trim().max(1000).optional(),
  terms: termsRequestSchema,
});

/**
 * POST /api/agreement-invitations — starts the anonymous-review invitation bridge. Boilerplate
 * legal-text term fields default to a generic placeholder when omitted (see
 * termsRequestSchema.ts's own doc comment) — this PRSprint's own "low-friction invitation bridge"
 * Goal means a quick P2P proposal must not force the sender through Sprint 5's full legal-text
 * form; PRSprint 11's amendment flow is where real legal language gets negotiated once the
 * agreement exists. Unlike relationships/invite (which never returns its raw token, since it's
 * always email-delivered only), this route *does* return the raw token/link to the authenticated
 * creator — this PRSprint's own "Copy secure link" / QR / WhatsApp share channels are all
 * sender-UI-driven and need the link once, at creation time. It is never persisted anywhere in
 * plaintext (AgreementInvitationService hashes it before storage) and never returned again
 * afterward.
 */
export function createAgreementInvitationHandler(authService: AuthService, invitationService: AgreementInvitationService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid invitation request is required.");
    }
    if (!parsed.data.recipientEmail && !parsed.data.recipientPhone && !parsed.data.recipientName) {
      throw new ValidationError("A recipient name, email, or phone number is required.");
    }

    if (!(await checkRateLimit(`agreement-invitation:inviter:${userId}`, INVITE_LIMIT_PER_INVITER, INVITE_WINDOW_MS))) {
      throw new RateLimitedError("Too many invitations sent. Please try again later.");
    }
    const targetKey = parsed.data.recipientEmail?.toLowerCase() ?? parsed.data.recipientPhone ?? null;
    if (targetKey && !(await checkRateLimit(`agreement-invitation:target:${targetKey}`, INVITE_LIMIT_PER_TARGET, INVITE_WINDOW_MS))) {
      throw new RateLimitedError("This contact has already been invited too many times recently.");
    }

    const { invitation, rawToken, link } = await invitationService.createInvitation({
      actingUserId: userId,
      inviterProfile: parsed.data.inviterProfile,
      inviterRole: parsed.data.inviterRole,
      recipientName: parsed.data.recipientName ?? null,
      recipientEmail: parsed.data.recipientEmail ?? null,
      recipientPhone: parsed.data.recipientPhone ?? null,
      currency: parsed.data.currency,
      message: parsed.data.message ?? null,
      terms: toDraftTermsInput(parsed.data.terms),
    });

    return NextResponse.json(
      { id: invitation.id, status: invitation.status, expiresAt: invitation.expiresAt, rawToken, link },
      { status: 201 },
    );
  };
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createAgreementInvitationHandler(getAuthService(), getAgreementInvitationService())(request);
}

export const POST = withErrorHandling("agreement_invitation_create", handleCreate);
