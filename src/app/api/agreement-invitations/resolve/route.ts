import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getAgreementInvitationService } from "@/lib/agreementInvitations/getAgreementInvitationService";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A random-token guess is the primary brute-force surface this route defends against — keyed by IP
// (there is no authenticated identity yet), generous enough not to break legitimate repeated opens
// (link previews, page refreshes) but well below what a guessing attack needs.
const RESOLVE_LIMIT_PER_IP = 60;
const RESOLVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * GET /api/agreement-invitations/resolve?token=... — deliberately unauthenticated: this is the
 * anonymous-review deep link. Read-only from the caller's perspective (see
 * AgreementInvitationService.resolvePublic's own doc comment for the one internal, idempotent,
 * scanner-safe `openedAt`/`viewed` bookkeeping it performs) and returns only the minimal public
 * projection — never an internal id, never the inviter's/recipient's account identity.
 */
async function handleResolve(request: NextRequest): Promise<Response> {
  if (!(await checkRateLimit(`agreement-invitation-resolve:ip:${getClientIp(request) ?? "unknown"}`, RESOLVE_LIMIT_PER_IP, RESOLVE_WINDOW_MS))) {
    throw new RateLimitedError("Too many requests. Please try again later.");
  }
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw new ValidationError("token is required.");
  const view = await getAgreementInvitationService().resolvePublic(token);
  return NextResponse.json(view, { status: 200 });
}

export const GET = withErrorHandling("agreement_invitation_resolve", handleResolve);
