import "server-only";
import { desc, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { auditEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AuditEventPayload } from "./hash";
import type { AuditEventRecord, AuditEventRepository } from "./auditService";

/**
 * R04/R07 corrective pass: fixed advisory-lock key pair identifying "the one global audit_event
 * chain" — every `appendAtomically` call serializes against every other one, regardless of which
 * agreement/actor/action it concerns.
 *
 * This is a COMPATIBILITY CONTRACT, not an implementation detail — changing either value is NOT
 * harmless. During a rolling deploy, an old-version instance and a new-version instance of this
 * service run concurrently against the same database for some window. If the new version changed
 * this key, the two versions would acquire and hold *different* advisory locks while both still
 * append to the exact same `audit_event` table — reintroducing the fork this remediation exists to
 * make impossible, silently, only during deploys. Never change these values without a coordinated,
 * versioned migration plan (e.g. a dual-lock transition period), and never "clean them up" as a
 * cosmetic refactor.
 */
const AUDIT_CHAIN_LOCK_KEY_A = "audit_event_chain";
const AUDIT_CHAIN_LOCK_KEY_B = "append";

type AuditEventRow = typeof auditEvent.$inferSelect;

function toRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
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
    targetResourceType: row.targetResourceType,
    targetResourceId: row.targetResourceId,
    eventHash: row.eventHash,
    previousEventHash: row.previousEventHash,
  };
}

function toInsertValues(record: Omit<AuditEventRecord, "id">) {
  return {
    actorUserId: record.actorUserId ?? undefined,
    actorRole: record.actorRole,
    profileKind: record.profileKind ?? undefined,
    profileId: record.profileId,
    agreementId: record.agreementId,
    action: record.action,
    occurredAt: new Date(record.occurredAt),
    ipAddress: record.ipAddress,
    deviceInfo: record.deviceInfo,
    previousValue: record.previousValue,
    newValue: record.newValue,
    reason: record.reason,
    authStrength: record.authStrength,
    relatedDocumentId: record.relatedDocumentId,
    relatedCaseId: record.relatedCaseId,
    targetResourceType: record.targetResourceType ?? undefined,
    targetResourceId: record.targetResourceId ?? undefined,
    eventHash: record.eventHash,
    previousEventHash: record.previousEventHash,
  };
}

/**
 * Real, Postgres-backed AuditEventRepository — the sole production implementation (every
 * `get*Service.ts` factory constructs it with no arguments). Its `appendAtomically` path is proven
 * against a real, disposable Postgres under genuine concurrent load in
 * `auditService.postgres.test.ts` (R04) — that suite is the regression guard against this class ever
 * silently losing the atomic append path.
 *
 * `getLastEvent`/`insertEvent` remain on the interface only because ~30 in-memory test fakes across
 * this codebase implement just those two (a full interface-wide migration to require
 * `appendAtomically` everywhere was judged not worth the blast radius for this corrective pass — see
 * the R03/R04/R05/R07 corrective-pass report). They are NOT the sanctioned way to append a new
 * event in production: `AuditService.record()` always prefers `appendAtomically` when a repository
 * implements it (every real one does), and nothing in this codebase calls `insertEvent`/
 * `getLastEvent` directly outside `AuditService` itself and this class's own tests.
 */
export class DrizzleAuditEventRepository implements AuditEventRepository {
  /**
   * R07 corrective pass: `db` is injectable (defaulting to the shared production singleton) solely
   * so `*.postgres.test.ts` concurrency suites can hand two instances of this SAME class two
   * genuinely distinct PostgreSQL connections — proving real transaction overlap/lock contention,
   * which a single shared `max: 1` connection structurally cannot exhibit. Every production call
   * site (`new DrizzleAuditEventRepository()`, no argument) is unaffected.
   */
  constructor(private readonly db: Database = getDb()) {}

  /** Read-only; never call this to decide what to write next — see `appendAtomically`. */
  async getLastEvent(): Promise<AuditEventRecord | null> {
    const db = this.db;
    const rows = await db.select().from(auditEvent).orderBy(desc(auditEvent.id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * ⚠️ Does NOT participate in the chain's serialization lock — calling this directly with a
   * pre-computed hash bypasses the whole point of `appendAtomically`. Exists only so `AuditService`
   * can fall back to it for repositories (in-memory test fakes) that don't implement the atomic
   * path; never call it directly to append a new production event.
   */
  async insertEvent(
    record: Omit<AuditEventRecord, "id">,
  ): Promise<AuditEventRecord> {
    const db = this.db;
    const [row] = await db.insert(auditEvent).values(toInsertValues(record)).returning();
    if (!row) {
      throw new ConfigurationError("audit_event insert returned no row");
    }
    return toRecord(row);
  }

  /**
   * R04 (DB integrity & concurrency hardening): the tail-read, hash-compute, and insert now happen
   * inside ONE transaction, serialized by a transaction-scoped advisory lock — see this module's own
   * `AUDIT_CHAIN_LOCK_KEY_*` doc comment and DrizzleRelationshipPairResolver's identical
   * `pg_advisory_xact_lock(hashtext(...), hashtext(...))` precedent for why this form (not
   * `pg_advisory_lock`) is required under Supabase's transaction-pooled connections
   * (src/db/client.ts). Every concurrent `AuditService.record()` call queues behind this lock, so the
   * tail each one reads is always the immediately-preceding committed event — a fork is structurally
   * impossible, not just unlikely.
   */
  async appendAtomically(
    payload: AuditEventPayload,
    computeHash: (previousEventHash: string | null) => string,
  ): Promise<AuditEventRecord> {
    const db = this.db;
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${AUDIT_CHAIN_LOCK_KEY_A}), hashtext(${AUDIT_CHAIN_LOCK_KEY_B}))`);

      const rows = await tx.select().from(auditEvent).orderBy(desc(auditEvent.id)).limit(1);
      const last = rows[0] ? toRecord(rows[0]) : null;
      const previousEventHash = last?.eventHash ?? null;
      const eventHash = computeHash(previousEventHash);

      const [row] = await tx
        .insert(auditEvent)
        .values(toInsertValues({ ...payload, eventHash, previousEventHash }))
        .returning();
      if (!row) {
        throw new ConfigurationError("audit_event insert returned no row during atomic append");
      }
      return toRecord(row);
    });
  }
}
