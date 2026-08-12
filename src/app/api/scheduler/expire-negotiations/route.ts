import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/config/env";
import { withErrorHandling } from "@/lib/api-handler";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { getPartialPaymentService } from "@/lib/partialPayments/getPartialPaymentService";
import type { PartialPaymentService } from "@/lib/partialPayments/partialPaymentService";
import { getSettlementService } from "@/lib/settlements/getSettlementService";
import type { SettlementService } from "@/lib/settlements/settlementService";

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
 * Sprint 15 (docs/sprints/SPRINT_15_ PartialPayments_Settlement.md): the cron-firing entry point for
 * both time-bound negotiations this sprint adds — "AwaitingPayment --> Expired: not paid within
 * proposed window" (`docs/STATE_MACHINES.md` §5) and "AwaitingSettlementPayment -->
 * FailureConsequenceApplied: deadline passes incomplete" (§6). Mirrors Sprint 13's
 * retry-failed-payments route exactly: Vercel has no persistent worker process, so this only fires
 * when a Vercel Cron Job (vercel.json) calls it with `Authorization: Bearer <CRON_SECRET>`.
 */
export function createExpireNegotiationsHandler(partialPaymentService: PartialPaymentService, settlementService: SettlementService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { CRON_SECRET } = getServerEnv();
    if (!CRON_SECRET) {
      throw new ConfigurationError("CRON_SECRET is not configured.");
    }
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${CRON_SECRET}`)) {
      throw new ForbiddenError("Invalid or missing scheduler authorization.");
    }

    const now = new Date();
    const partialPayments = await partialPaymentService.expireOverdue(now);
    const settlements = await settlementService.expireOverdueSettlements(now);
    return NextResponse.json({ status: "ok", partialPayments, settlements }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createExpireNegotiationsHandler(getPartialPaymentService(), getSettlementService())(request);
}

export const POST = withErrorHandling("scheduler_expire_negotiations", handlePost);
