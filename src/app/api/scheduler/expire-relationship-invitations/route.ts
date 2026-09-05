import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/config/env";
import { withErrorHandling } from "@/lib/api-handler";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { getRelationshipInvitationService } from "@/lib/relationships/getRelationshipInvitationService";
import type { RelationshipInvitationService } from "@/lib/relationships/relationshipInvitationService";

/** Matches src/app/api/scheduler/retry-failed-payments/route.ts's identical constant-time comparison precedent. */
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
 * Sprint 18A remediation: the cron-firing entry point for
 * `RelationshipInvitationService.expireDueInvitations` — that method and its own hygiene were already
 * built and tested in the original pass, but nothing ever called it in production; this route is the
 * one missing piece. Mirrors Sprint 13/15/17's identical scheduler-route shape exactly: Vercel has no
 * persistent worker process, so a due expiration only actually fires when a Vercel Cron Job
 * (vercel.json) calls this route with `Authorization: Bearer <CRON_SECRET>`. No expiration logic
 * lives here — this route is a thin, authenticated trigger only.
 *
 * Idempotent by construction: `expireDueInvitations` only ever selects invitations still in `sent`/
 * `viewed` status whose `expires_at` has passed (`findDueForExpiry`); once marked `expired`, a repeated
 * call — whether from this route firing twice, an overlapping cron invocation, or a manual retry —
 * finds nothing left to do for that invitation. Accepted/declined/cancelled/already-expired invitations
 * are never selected by `findDueForExpiry` in the first place, so they are structurally unreachable
 * from this route, not merely "not touched by convention."
 */
export function createExpireRelationshipInvitationsHandler(invitationService: RelationshipInvitationService) {
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
  return createExpireRelationshipInvitationsHandler(getRelationshipInvitationService())(request);
}

export const POST = withErrorHandling("scheduler_expire_relationship_invitations", handlePost);
// Vercel Cron invokes the configured path with HTTP GET (see vercel.json); POST is kept for
// backward compatibility. Same handler reference for both — no duplicated business logic, and the
// CRON_SECRET check inside handlePost runs identically regardless of which verb reached it.
export const GET = POST;
