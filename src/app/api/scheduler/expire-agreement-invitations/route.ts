import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/config/env";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementInvitationService } from "@/lib/agreementInvitations/agreementInvitationService";
import { getAgreementInvitationService } from "@/lib/agreementInvitations/getAgreementInvitationService";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";

/** Matches src/app/api/scheduler/expire-relationship-invitations/route.ts's identical constant-time comparison precedent. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * PRSprint 10: the cron-firing entry point for `AgreementInvitationService.expireDueInvitations` —
 * mirrors src/app/api/scheduler/expire-relationship-invitations/route.ts's shape exactly (same
 * constant-time `CRON_SECRET` check, same idempotent-by-construction guarantee via
 * `findDueForExpiry` only ever selecting still-open, past-expiry rows). No expiration logic lives
 * here — this route is a thin, authenticated trigger only.
 */
export function createExpireAgreementInvitationsHandler(invitationService: AgreementInvitationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { CRON_SECRET } = getServerEnv();
    if (!CRON_SECRET) {
      throw new ConfigurationError("CRON_SECRET is not configured.");
    }
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${CRON_SECRET}`)) {
      throw new ForbiddenError("Invalid or missing scheduler authorization.");
    }

    const result = await invitationService.expireDueInvitations(new Date());
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createExpireAgreementInvitationsHandler(getAgreementInvitationService())(request);
}

export const POST = withErrorHandling("scheduler_expire_agreement_invitations", handlePost);
// Vercel Cron invokes the configured path with HTTP GET (see vercel.json); POST is kept for
// backward compatibility. Same handler reference for both — no duplicated business logic, and the
// CRON_SECRET check inside handlePost runs identically regardless of which verb reached it.
export const GET = POST;
