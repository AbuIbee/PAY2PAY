import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/config/env";
import { withErrorHandling } from "@/lib/api-handler";
import { ConfigurationError, ForbiddenError } from "@/lib/errors";
import { getReconciliationService } from "@/lib/ledger/getReconciliationService";
import type { ReconciliationService } from "@/lib/ledger/reconciliationService";
import { getPaymentWebhookService } from "@/lib/payments/getPaymentWebhookService";
import type { PaymentWebhookService } from "@/lib/payments/paymentWebhookService";

/** Constant-time comparison, matching retry-failed-payments/route.ts's own identical precedent. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bounded per invocation (see BATCH_SIZE below), but give this background job real headroom rather
// than the platform default, matching retry-failed-payments/route.ts's own identical rationale.
export const maxDuration = 60;

/**
 * R06 (webhook processed-state / redelivery recovery): the automatic recovery execution path this
 * remediation requires — "there must be a real path that runs recovery without an administrator
 * manually clicking something." Intended caller: a Vercel Cron Job configured in vercel.json, which
 * automatically sends `Authorization: Bearer <CRON_SECRET>` — this route's whole authorization
 * surface, mirroring retry-failed-payments/route.ts's identical GET-compatible, CRON_SECRET-gated
 * pattern (R01: Vercel Cron invokes the configured path with HTTP GET).
 *
 * Bounded (BATCH_SIZE), retry-safe (every claim is `FOR UPDATE SKIP LOCKED`, so overlapping/parallel
 * invocations of this same route — a slow run plus the next scheduled tick, or two Vercel Cron
 * regions — can never claim the same row twice), and never an unbounded full-table scan (the claim
 * query is index-backed — see the R06 migration's own `payment_webhook_event_recovery_scan_idx`).
 *
 * R09 corrective pass (Codex blocker 1 — automatic reconciliation/convergence): this same tick also
 * runs `ReconciliationService.repairBatch` — bounded via `listRecentlySucceeded`
 * (`payment_attempt_status_updated_at_idx`), never `reconcileAll()`'s unbounded scan — so BOTH
 * previously-manual-only repair shapes (a succeeded/processed payment missing its ledger clearing
 * entry, and a cleared payment whose agreement-lifecycle advancement never ran) now converge
 * automatically on every scheduler tick, under the same CRON_SECRET/GET-compatible contract.
 */
const BATCH_SIZE = 50;
const RECONCILIATION_BATCH_SIZE = 50;

export function createRecoverPaymentWebhooksHandler(paymentWebhookService: PaymentWebhookService, reconciliationService: ReconciliationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { CRON_SECRET } = getServerEnv();
    if (!CRON_SECRET) {
      throw new ConfigurationError("CRON_SECRET is not configured.");
    }
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${CRON_SECRET}`)) {
      throw new ForbiddenError("Invalid or missing scheduler authorization.");
    }

    const result = await paymentWebhookService.recoverBatch(BATCH_SIZE);
    const reconciliation = await reconciliationService.repairBatch(RECONCILIATION_BATCH_SIZE);
    return NextResponse.json({ status: "ok", ...result, reconciliation }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createRecoverPaymentWebhooksHandler(getPaymentWebhookService(), getReconciliationService())(request);
}

export const POST = withErrorHandling("scheduler_recover_payment_webhooks", handlePost);
// Vercel Cron invokes the configured path with HTTP GET (see vercel.json); POST is kept for
// backward/manual-trigger compatibility, matching retry-failed-payments/route.ts's identical
// GET-aliases-POST wiring for R01.
export const GET = POST;
