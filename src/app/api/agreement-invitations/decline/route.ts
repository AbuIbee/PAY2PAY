import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementInvitationService } from "@/lib/agreementInvitations/agreementInvitationService";
import { getAgreementInvitationService } from "@/lib/agreementInvitations/getAgreementInvitationService";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DECLINE_LIMIT_PER_IP = 30;
const DECLINE_WINDOW_MS = 15 * 60 * 1000;

const declineSchema = z.object({ token: z.string().trim().min(1) });

/**
 * POST /api/agreement-invitations/decline — deliberately token-only, no authentication required
 * (this PRSprint's own acceptance criteria names verified identity as required only for "Formal
 * Accept/Counter", not Decline). Still a POST a human must explicitly trigger — never reachable by
 * a GET/link-preview scanner, which is the actual "must not be triggerable by link scanners"
 * requirement.
 */
export function createAgreementInvitationDeclineHandler(invitationService: AgreementInvitationService) {
  return async function handleDecline(request: NextRequest): Promise<Response> {
    if (!(await checkRateLimit(`agreement-invitation-decline:ip:${getClientIp(request) ?? "unknown"}`, DECLINE_LIMIT_PER_IP, DECLINE_WINDOW_MS))) {
      throw new RateLimitedError("Too many requests. Please try again later.");
    }
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = declineSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid token is required.");

    await invitationService.declinePublic(parsed.data.token);
    return NextResponse.json({ status: "declined" }, { status: 200 });
  };
}

async function handleDecline(request: NextRequest): Promise<Response> {
  return createAgreementInvitationDeclineHandler(getAgreementInvitationService())(request);
}

export const POST = withErrorHandling("agreement_invitation_decline", handleDecline);
