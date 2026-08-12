import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/config/env";
import { withErrorHandling } from "@/lib/api-handler";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { getPaymentRetryService } from "@/lib/failedPayments/getPaymentRetryService";
import type { PaymentRetryService } from "@/lib/failedPayments/paymentRetryService";

/** Constant-time comparison, matching src/lib/webhookSignature.ts's verifyHmacSignature precedent — a plain `!==` on a bearer secret is a minor timing-attack surface this codebase otherwise avoids for every other secret comparison. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cron-firing can process an arbitrary number of due retries; give it real headroom rather than the
// platform default, matching a background-job route's expected profile (not a user-facing request).
export const maxDuration = 60;

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): the "background job/scheduler
 * abstraction compatible with Vercel architecture" this sprint requires — Vercel has no persistent
 * worker process, so a scheduled retry only actually fires when something calls this route. Intended
 * caller: a Vercel Cron Job configured in vercel.json, which automatically sends
 * `Authorization: Bearer <CRON_SECRET>` — this route's whole authorization surface, mirroring the
 * webhook route's signature-only trust model (deliberately unauthenticated via requireSession; no
 * user session is meaningful for a system-initiated call).
 */
export function createRetryFailedPaymentsHandler(paymentRetryService: PaymentRetryService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { CRON_SECRET } = getServerEnv();
    if (!CRON_SECRET) {
      throw new ConfigurationError("CRON_SECRET is not configured.");
    }
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${CRON_SECRET}`)) {
      throw new ForbiddenError("Invalid or missing scheduler authorization.");
    }

    const result = await paymentRetryService.fireDueRetries();
    return NextResponse.json({ status: "ok", ...result }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createRetryFailedPaymentsHandler(getPaymentRetryService())(request);
}

export const POST = withErrorHandling("scheduler_retry_failed_payments", handlePost);
