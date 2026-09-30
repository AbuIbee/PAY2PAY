/**
 * STAGE 2 PHASE C TEST-FAILURE REMEDIATION — TEST 008-I correction. Test-only. Not imported by any
 * production code path.
 *
 * `paymentWebhookRecovery.postgres.test.ts` runs 150+ tests sequentially against one shared, real
 * PostgreSQL database with no per-test rollback. `PaymentRetryService.fireDueRetries` is a genuine
 * scheduler-style method — by design, it discovers and resolves EVERY due `claimed` retry in the
 * whole `payment_retry` table, not merely the one row a given test itself created (this is correct
 * production behavior and must never be narrowed just to make a test more convenient). The previous
 * version of TEST 008-I counted every invocation of its own provider double with a single global
 * counter, so an unrelated retry — left `claimed` and due by some earlier test — incidentally swept
 * up by the SAME `fireDueRetries` call silently consumed one of the counted attempts, producing a
 * false "4 instead of 3" failure with no code defect involved at all (see
 * docs/remediation/STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md, Section A, for the full, empirically
 * reproduced trace).
 *
 * This counter tracks attempts PER idempotency key instead of globally, so a test can assert on the
 * count for the ONE key it actually cares about, immune to however many unrelated keys interleave
 * before, between, or after its own calls — while still recording every call, for every key, so an
 * unrelated invocation is never silently invisible.
 */
export interface PerKeyProviderCallCounter {
  /** Records one call for `key` and returns the running count for THAT key only (never a shared/global total). */
  record(key: string): number;
  /** The current recorded count for `key` (0 if `record` has never been called for it). */
  countFor(key: string): number;
  /** Every distinct key `record` has ever been called with, in first-seen order — for diagnostic visibility, never silently dropped. */
  keys(): string[];
}

export function createPerKeyProviderCallCounter(): PerKeyProviderCallCounter {
  const counts = new Map<string, number>();
  return {
    record(key: string): number {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    countFor(key: string): number {
      return counts.get(key) ?? 0;
    },
    keys(): string[] {
      return [...counts.keys()];
    },
  };
}
