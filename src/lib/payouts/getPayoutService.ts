import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzleAtomicPayoutConfirmer } from "./atomicPayoutConfirmer";
import { DrizzleAtomicPayoutReturner } from "./atomicPayoutReturner";
import { DrizzlePayoutAttemptRepository } from "./drizzlePayoutAttemptRepository";
import { PayoutService } from "./payoutService";

let cached: PayoutService | null = null;

/**
 * Lazily creates (and memoizes) the production PayoutService. Deliberately NEVER gates construction
 * itself on `PAYOUT_PROVIDER_INTEGRATION_VERIFIED` — unlike `getBankConnectionService()`'s identical-
 * looking `ADYEN_ACH_TOKENIZATION_VERIFIED` gate, this service's `recordPayoutOwed`/`failPayout` paths
 * must keep working (durably, honestly tracking what's owed) with no live provider configured at all;
 * that is the entire point of B0-D PHASE 3A. Only `confirmPayout` itself is gated — see
 * `PayoutService`'s own doc comment (src/lib/payouts/payoutService.ts) for PHASE 3B's rationale.
 *
 * PAID2YOU — B0-D PHASE 3B (G2/G3 correction): `atomicConfirmer`/`atomicReturner` are ALWAYS wired
 * here to the real `DrizzleAtomicPayoutConfirmer`/`DrizzleAtomicPayoutReturner` — this is the ONLY
 * production construction site for `PayoutService` (see `PayoutService`'s own doc comment's "SOLE
 * place" claim, verified by a full-repository caller trace), so every real `confirmPayout`/
 * `returnPayout` call always goes through the atomic, transaction-bound, row-lock-protected path.
 * The non-atomic sequential fallback in `PayoutService` is reachable only through direct construction
 * bypassing this factory — which nothing in this codebase does.
 */
export function getPayoutService(): PayoutService {
  if (!cached) {
    const env = getServerEnv();
    cached = new PayoutService({
      payoutAttempts: new DrizzlePayoutAttemptRepository(),
      ledger: getLedgerService(),
      payments: new DrizzlePaymentAttemptRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      payoutProviderIntegrationVerified: env.PAYOUT_PROVIDER_INTEGRATION_VERIFIED,
      atomicConfirmer: new DrizzleAtomicPayoutConfirmer(),
      atomicReturner: new DrizzleAtomicPayoutReturner(),
    });
  }
  return cached;
}
