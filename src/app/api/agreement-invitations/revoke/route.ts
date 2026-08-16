import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementInvitationService } from "@/lib/agreementInvitations/agreementInvitationService";
import { getAgreementInvitationService } from "@/lib/agreementInvitations/getAgreementInvitationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const revokeSchema = z.object({ invitationId: z.string().uuid() });

/** POST /api/agreement-invitations/revoke — sender-only. Immediately invalidates the outstanding link. */
export function createAgreementInvitationRevokeHandler(authService: AuthService, invitationService: AgreementInvitationService) {
  return async function handleRevoke(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = revokeSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("invitationId is required.");

    const invitation = await invitationService.revokeInvitation(parsed.data.invitationId, userId);
    return NextResponse.json({ id: invitation.id, status: invitation.status }, { status: 200 });
  };
}

async function handleRevoke(request: NextRequest): Promise<Response> {
  return createAgreementInvitationRevokeHandler(getAuthService(), getAgreementInvitationService())(request);
}

export const POST = withErrorHandling("agreement_invitation_revoke", handleRevoke);
