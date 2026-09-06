import { randomUUID } from "node:crypto";
import { asc, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getServerEnv } from "@/config/env";
import { getDb } from "@/db/client";
import { auditEvent } from "@/db/schema";
import { acquireAdvisoryLockBarrier } from "../../../test/postgres/lockBarrier";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";
import { AuditService } from "./auditService";
import { DrizzleAuditEventRepository } from "./drizzleAuditEventRepository";
import { computeAuditEventHash, type AuditEventPayload } from "./hash";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * R04 (DB integrity & concurrency hardening) — real-Postgres proof that
 * `DrizzleAuditEventRepository.appendAtomically` (via `AuditService.record`) serializes concurrent
 * appends into one linear hash chain, never a fork, against the real database.
 *
 * These assertions deliberately verify the chain's integrity across the WHOLE `audit_event` table,
 * not just "the rows this test itself wrote" — every writer in this suite (this file, and any other
 * `*.postgres.test.ts` file that happens to call a real `AuditService`) goes through the same atomic,
 * lock-serialized `appendAtomically` path, and `vitest.postgres.config.ts` runs test files
 * sequentially (never in parallel), so the table is expected to form exactly one valid, unbroken
 * chain from genesis to tip regardless of which file wrote which row or in what order the files ran.
 * A fork or lost/corrupted link anywhere in the table — from this file's own writes or another's —
 * is exactly the defect this remediation exists to make structurally impossible.
 */
function payload(action: string): AuditEventPayload {
  return {
    actorUserId: null,
    actorRole: "system",
    profileKind: null,
    profileId: null,
    agreementId: null,
    action,
    occurredAt: new Date().toISOString(),
    ipAddress: null,
    deviceInfo: null,
    previousValue: null,
    newValue: null,
    reason: null,
    authStrength: null,
    relatedDocumentId: null,
    relatedCaseId: null,
  };
}

/**
 * Verifies chain LINKAGE across the WHOLE `audit_event` table (every writer in this whole
 * `*.postgres.test.ts` run — this file and any other that happens to call a real `AuditService` —
 * goes through the same atomic, lock-serialized `appendAtomically` path, and test files run
 * sequentially, never in parallel, so the table is expected to form exactly one valid, unbroken
 * chain from genesis to tip). Deliberately does NOT recompute hashes here: `previousValue`/
 * `newValue` on a row written by a DIFFERENT test file (e.g. `AgreementService.recordAudit`'s own
 * multi-key object payloads) round-trip through a `jsonb` column, and Postgres's `jsonb` storage
 * does not preserve original key order — recomputing `computeAuditEventHash` from a read-back
 * object could reorder keys relative to the object that was actually hashed at write time,
 * producing a false-positive mismatch that reflects a JSONB round-trip quirk, not a real defect.
 * Checking only that `previousEventHash` equals the immediately-preceding row's `eventHash` (in id
 * order) still fully proves "no fork, no lost event, exactly one genesis" — a fork is structurally
 * impossible to hide from this check regardless of payload shape.
 */
async function verifyWholeChainLinkage(): Promise<void> {
  const db = getDb();
  const rows = await db.select({ previousEventHash: auditEvent.previousEventHash, eventHash: auditEvent.eventHash }).from(auditEvent).orderBy(asc(auditEvent.id));
  expect(rows.length).toBeGreaterThan(0);

  const genesisRows = rows.filter((r) => r.previousEventHash === null);
  expect(genesisRows).toHaveLength(1); // exactly one root — never zero, never more than one.

  let previousEventHash: string | null = null;
  for (const row of rows) {
    expect(row.previousEventHash).toBe(previousEventHash); // links to the immediately preceding row, in id order — a fork would break this.
    previousEventHash = row.eventHash;
  }
}

/**
 * Recomputes and verifies `eventHash` for a SPECIFIC set of ids this test itself created with the
 * simple, flat, no-nested-object `payload()` shape above (safe against the JSONB key-reordering
 * concern `verifyWholeChainLinkage` deliberately avoids) — proving the hash isn't just internally
 * consistent (that's `verifyWholeChainLinkage`'s job) but actually, verifiably correct per
 * `computeAuditEventHash`.
 */
async function verifyOwnRowHashes(ids: number[]): Promise<void> {
  const { AUDIT_HASH_SECRET } = getServerEnv();
  const db = getDb();
  const rows = await db.select().from(auditEvent).where(inArray(auditEvent.id, ids)).orderBy(asc(auditEvent.id));
  expect(rows).toHaveLength(ids.length);
  for (const row of rows) {
    const recomputed = computeAuditEventHash(
      {
        actorUserId: row.actorUserId,
        actorRole: row.actorRole,
        profileKind: row.profileKind,
        profileId: row.profileId,
        agreementId: row.agreementId,
        action: row.action,
        occurredAt: row.occurredAt.toISOString(),
        ipAddress: row.ipAddress,
        deviceInfo: row.deviceInfo,
        previousValue: row.previousValue,
        newValue: row.newValue,
        reason: row.reason,
        authStrength: row.authStrength,
        relatedDocumentId: row.relatedDocumentId,
        relatedCaseId: row.relatedCaseId,
        // `canonicalize()` (src/lib/audit/hash.ts) drops a key entirely when it's `undefined` (the
        // shape `payload()` above always produces, since it never sets these two optional fields) —
        // but a DB round-trip can only ever hand back `null` for an unset column, never `undefined`.
        // Normalizing back to `undefined` here reconstructs the exact input shape that was actually
        // hashed at write time; this is a test-verification concern only, never a change to the hash
        // algorithm itself.
        targetResourceType: row.targetResourceType ?? undefined,
        targetResourceId: row.targetResourceId ?? undefined,
      },
      row.previousEventHash,
      AUDIT_HASH_SECRET,
    );
    expect(row.eventHash).toBe(recomputed); // no mutable/re-written historical event.
  }
}

describe("R04: AuditService + DrizzleAuditEventRepository.appendAtomically (real Postgres)", () => {
  it("R04-A (contention proof): a real append genuinely blocks on the production audit advisory lock, not merely 'runs after' in JS scheduling", async () => {
    // Corrective pass (Codex finding D): pre-acquires the EXACT SAME advisory lock key
    // `appendAtomically` uses (`hashtext('audit_event_chain'), hashtext('append')`) on its own
    // connection, then fires one real `record()` call on a SEPARATE, independent connection —
    // `waitUntilContended()` proves, via `pg_stat_activity`, that the real append is genuinely
    // blocked waiting for this lock before it's released, not just issued and hoped-to-overlap.
    const isolated = createIsolatedDb(DATABASE_URL);
    try {
      const isolatedPid = await warmUp(isolated.client);
      const barrier = await acquireAdvisoryLockBarrier(DATABASE_URL, "audit_event_chain", "append");
      const audit = new AuditService(new DrizzleAuditEventRepository(isolated.db));
      const recordPromise = audit.record(payload(`r04a_contention_proof_${randomUUID()}`));

      // Codex (nonblocking cleanup): protect the release with `finally` so a failed/timed-out
      // contention assertion can never leave the holder's lock/connection open for the rest of this
      // test file's run.
      try {
        await barrier.waitUntilContended({ expectPids: [isolatedPid] });
      } finally {
        await barrier.release();
      }

      const recorded = await recordPromise;
      expect(recorded.id).toBeGreaterThan(0);
    } finally {
      await isolated.close();
    }
  });

  it("R04-A: 20+ concurrent record() calls on genuinely distinct connections all persist, form exactly one chain, and every hash recomputes correctly", async () => {
    // Corrective pass (Codex finding B/D): 24 fully independent Postgres connections (never the
    // shared, max:1 `getDb()` singleton) each construct their own AuditService, so these 24
    // record() calls are real, separate backend processes genuinely contending for the same
    // production advisory lock — not 24 calls serialized through one shared connection, which could
    // never actually exercise lock contention at all.
    const CONCURRENCY = 24;
    const isolated = Array.from({ length: CONCURRENCY }, () => createIsolatedDb(DATABASE_URL));
    try {
      const batchTag = randomUUID();
      const results = await Promise.all(
        isolated.map((conn, i) => new AuditService(new DrizzleAuditEventRepository(conn.db)).record(payload(`r04a_concurrent_${batchTag}_${i}`))),
      );

      const ids = results.map((r) => r.id);
      expect(new Set(ids).size).toBe(CONCURRENCY); // no lost event, no duplicate id.

      await verifyWholeChainLinkage();
      await verifyOwnRowHashes(ids);
    } finally {
      await Promise.all(isolated.map((conn) => conn.close()));
    }
  });

  it("R04-B: a forced append failure (FK violation) rolls back cleanly, and the next successful append continues from the correct, unaffected tail", async () => {
    const audit = new AuditService(new DrizzleAuditEventRepository());
    const repo = new DrizzleAuditEventRepository();

    const before = await repo.getLastEvent();

    // A non-existent actorUserId violates audit_event.actor_user_id's real FK to user_account —
    // forces the transaction to fail on INSERT, after the tail has already been read inside it.
    const failingPayload: AuditEventPayload = { ...payload("r04b_forced_failure"), actorUserId: randomUUID() };
    await expect(
      repo.appendAtomically(failingPayload, (previousEventHash) =>
        computeAuditEventHash(failingPayload, previousEventHash, getServerEnv().AUDIT_HASH_SECRET),
      ),
    ).rejects.toThrow();

    const afterFailure = await repo.getLastEvent();
    expect(afterFailure?.id).toBe(before?.id ?? null);
    expect(afterFailure?.eventHash).toBe(before?.eventHash ?? null); // tail unchanged by the failed attempt.

    const recovered = await audit.record(payload("r04b_recovery_append"));
    expect(recovered.previousEventHash).toBe(before?.eventHash ?? null); // continues from the correct tail, not a corrupted one.

    await verifyWholeChainLinkage();
    await verifyOwnRowHashes([recovered.id]);
  });
});
