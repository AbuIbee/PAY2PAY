import "server-only";
import { getServerEnv } from "@/config/env";
import { computeAuditEventHash, type AuditEventPayload } from "./hash";

export interface AuditEventRecord extends AuditEventPayload {
  id: number;
  eventHash: string;
  previousEventHash: string | null;
}

/**
 * Storage abstraction the AuditService writes through. Keeping this as an
 * interface (rather than calling Drizzle directly) lets Phase 0's tests
 * exercise the hash-chaining/orchestration logic against an in-memory fake
 * without a live database — see src/lib/audit/auditService.test.ts. The
 * real implementation is DrizzleAuditEventRepository
 * (src/lib/audit/drizzleAuditEventRepository.ts).
 */
export interface AuditEventRepository {
  getLastEvent(): Promise<AuditEventRecord | null>;
  insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord>;
  /**
   * R04 (DB integrity & concurrency hardening): atomically reads the current chain tail, computes
   * this event's hash via `computeHash`, and inserts it — all inside one serialized operation, so
   * concurrent `AuditService.record()` calls can never both observe the same tail and fork the chain.
   * Optional: only the real Postgres-backed repository (DrizzleAuditEventRepository) implements it,
   * via `db.transaction` plus a transaction-scoped advisory lock serializing the whole chain. Every
   * in-memory test fake omits it — `record()` below falls back to the pre-existing
   * `getLastEvent` -> `insertEvent` sequence.
   *
   * That fallback is NOT itself fork-proof under concurrent use, even against a fake whose own
   * method bodies contain no internal `await` — `record()` itself awaits `getLastEvent()` and then
   * separately awaits `insertEvent(...)`, and each `await` is a real suspension point in JS's event
   * loop: two `Promise.all`-driven `record()` calls against the SAME fake instance can genuinely
   * interleave at that boundary (call A reads the tail, suspends; call B reads the SAME tail before A
   * resumes and writes; both then write claiming the same `previousEventHash` — a fork). This is
   * safe ONLY because no existing test in this codebase calls a fake's `record()` concurrently — every
   * caller invokes it as one step of an otherwise-sequential business-logic flow. Do not rely on this
   * fallback path for any test that races `record()` calls; use the real Postgres path
   * (`auditService.postgres.test.ts`) for that. Hash algorithm and `AUDIT_HASH_SECRET` semantics
   * are unchanged either way — `computeHash` is the exact same `computeAuditEventHash` call `record()`
   * always made, just handed to the repository instead of applied before calling it, so the tail it's
   * computed against is guaranteed to be the one this specific insert actually chains onto.
   */
  appendAtomically?(payload: AuditEventPayload, computeHash: (previousEventHash: string | null) => string): Promise<AuditEventRecord>;

  /**
   * Stage 4 (S4-03 remediation — concurrent payout audit repair is not idempotent). Atomic
   * get-or-create: while the SAME chain-serializing lock `appendAtomically` uses is held, checks
   * whether an event matching `identity` already exists; if so, returns it (no insert, no second
   * caller ever appends a second one). If not, appends exactly one new event using the SAME
   * hash-chain semantics as `appendAtomically`, still inside that lock/transaction. `identity` never
   * includes a timestamp — only the caller-supplied resource/action tuple. Optional, mirroring
   * `appendAtomically`'s own established optional-capability shape; every in-memory test fake that
   * omits it causes `AuditService.ensureRecorded` to fall back to a caller-supplied, non-atomic
   * existence check (safe for sequential test use, never relied on in production).
   */
  ensureAtomically?(
    identity: { targetResourceType: string; targetResourceId: string; action: string },
    payload: AuditEventPayload,
    computeHash: (previousEventHash: string | null) => string,
  ): Promise<{ event: AuditEventRecord; created: boolean }>;
}

/**
 * Single write path into the append-only audit trail. Every domain service
 * is expected to call AuditService.record(...) rather than writing
 * audit_event rows directly (NFR-AUDIT-002, docs/ARCHITECTURE.md §2) — no
 * such domain service exists yet in Phase 0, but this is the seam they will
 * all go through starting in Phase 1.
 */
export class AuditService {
  constructor(private readonly repository: AuditEventRepository) {}

  async record(payload: AuditEventPayload): Promise<AuditEventRecord> {
    const { AUDIT_HASH_SECRET } = getServerEnv();
    const computeHash = (previousEventHash: string | null) => computeAuditEventHash(payload, previousEventHash, AUDIT_HASH_SECRET);
    if (this.repository.appendAtomically) {
      return this.repository.appendAtomically(payload, computeHash);
    }
    const last = await this.repository.getLastEvent();
    const previousEventHash = last?.eventHash ?? null;
    const eventHash = computeHash(previousEventHash);
    return this.repository.insertEvent({ ...payload, eventHash, previousEventHash });
  }

  /**
   * Stage 4 (S4-03 remediation). The one place a caller (e.g. `PayoutService`'s idempotent-replay
   * audit repair) should ask "does the required event for this identity already exist, and if not,
   * create exactly one" — never a caller-composed check-then-`record()` sequence, which is exactly
   * the non-atomic pattern that let two concurrent replay callers each observe absence and each
   * append, producing two events for one financial effect. Delegates to the repository's own
   * `ensureAtomically` (every real repository implements it) for a genuine, DB-lock-serialized
   * guarantee; `findExisting` is consulted only in the non-atomic fallback for a repository that
   * omits it (in-memory test fakes only).
   */
  async ensureRecorded(
    identity: { targetResourceType: string; targetResourceId: string; action: string },
    payload: AuditEventPayload,
    findExisting?: () => Promise<AuditEventRecord | null>,
  ): Promise<{ event: AuditEventRecord; created: boolean }> {
    const { AUDIT_HASH_SECRET } = getServerEnv();
    const computeHash = (previousEventHash: string | null) => computeAuditEventHash(payload, previousEventHash, AUDIT_HASH_SECRET);
    if (this.repository.ensureAtomically) {
      return this.repository.ensureAtomically(identity, payload, computeHash);
    }
    const existing = await findExisting?.();
    if (existing) return { event: existing, created: false };
    const last = await this.repository.getLastEvent();
    const previousEventHash = last?.eventHash ?? null;
    const eventHash = computeHash(previousEventHash);
    const event = await this.repository.insertEvent({ ...payload, eventHash, previousEventHash });
    return { event, created: true };
  }
}
