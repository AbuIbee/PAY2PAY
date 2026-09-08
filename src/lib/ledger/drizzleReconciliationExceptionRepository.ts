import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { reconciliationException } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { ReconciliationExceptionRecord, ReconciliationExceptionRepository, ReconciliationExceptionType } from "./reconciliationService";

type Row = typeof reconciliationException.$inferSelect;

function toRecord(row: Row): ReconciliationExceptionRecord {
  return {
    id: row.id,
    exceptionType: row.exceptionType,
    paymentAttemptId: row.paymentAttemptId,
    providerEventId: row.providerEventId,
    details: row.details,
    status: row.status,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
    resolutionReason: row.resolutionReason,
  };
}

/**
 * PAID2YOU — PACKAGE B (Stage 9 remediation, TEST QUALITY CORRECTION — DETERMINISTIC
 * CONFLICT-EXCEPTION CONTENTION). The same kind of production-safe, no-op-by-default test-only
 * affordance as `InstallmentLockTestHooks` (see `failedPaymentRetryCoordinator.ts`'s own doc
 * comment) — lets a `*.postgres.test.ts` suite pause `ensureOpenException`'s own INSERT the instant
 * it has genuinely issued its statement (still inside an open transaction, before commit), long
 * enough to deterministically prove a second, independent connection's own conflicting insert
 * attempt is REALLY blocked behind it (via `pg_stat_activity`), never a `Promise.all`-and-hope proof.
 * Defaults to `undefined`; every production call site (`new DrizzleReconciliationExceptionRepository()`,
 * no second argument) never sets it, so this can never run, or even be checked, outside a test —
 * inaccessible from any HTTP/user input, since it is a constructor-injected TypeScript-only value,
 * never part of any request payload or route.
 */
export interface ReconciliationExceptionInsertTestHooks {
  /** Awaited immediately after the INSERT statement has been issued — from this point until the hook resolves, this transaction genuinely holds whatever row/index-entry contention that insert produced, uncommitted. */
  afterInsertBeforeCommit?: () => Promise<void>;
}

export class DrizzleReconciliationExceptionRepository implements ReconciliationExceptionRepository {
  /**
   * R07-style injectability: `db` defaults to the shared production singleton solely so
   * `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct connection.
   * Every production call site (`new DrizzleReconciliationExceptionRepository()`, no argument) is
   * unaffected.
   */
  constructor(
    private readonly injectedDb: Database = getDb(),
    private readonly testHooks?: ReconciliationExceptionInsertTestHooks,
  ) {}

  async findOpen(
    exceptionType: ReconciliationExceptionType,
    paymentAttemptId: string | null,
    providerEventId: string | null,
  ): Promise<ReconciliationExceptionRecord | null> {
    const db = this.injectedDb;
    const rows = await db
      .select()
      .from(reconciliationException)
      .where(
        and(
          eq(reconciliationException.exceptionType, exceptionType),
          eq(reconciliationException.status, "open"),
          paymentAttemptId ? eq(reconciliationException.paymentAttemptId, paymentAttemptId) : isNull(reconciliationException.paymentAttemptId),
          providerEventId ? eq(reconciliationException.providerEventId, providerEventId) : isNull(reconciliationException.providerEventId),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async insert(input: {
    exceptionType: ReconciliationExceptionType;
    paymentAttemptId: string | null;
    providerEventId: string | null;
    details: unknown;
  }): Promise<ReconciliationExceptionRecord> {
    const db = this.injectedDb;
    const [row] = await db.insert(reconciliationException).values(input).returning();
    if (!row) throw new ConfigurationError("reconciliation_exception insert returned no row");
    return toRecord(row);
  }

  async listOpen(): Promise<ReconciliationExceptionRecord[]> {
    const db = this.injectedDb;
    const rows = await db.select().from(reconciliationException).where(eq(reconciliationException.status, "open"));
    return rows.map(toRecord);
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<ReconciliationExceptionRecord[]> {
    const db = this.injectedDb;
    const rows = await db.select().from(reconciliationException).where(eq(reconciliationException.paymentAttemptId, paymentAttemptId));
    return rows.map(toRecord);
  }

  /**
   * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1 — CONFLICT EXCEPTION
   * IDEMPOTENCY): `INSERT ... ON CONFLICT (payment_attempt_id, provider_event_id, exception_type)
   * WHERE status = 'open' DO NOTHING` — matching `reconciliation_exception_open_identity_unique`'s
   * own partial-index predicate exactly (Postgres requires the ON CONFLICT target's own WHERE clause
   * to match a real partial index verbatim). `.returning()` comes back empty precisely when an open
   * exception with this identity already existed — the DB itself is what decided that, atomically,
   * never a separate read this method performed first.
   */
  async ensureOpenException(input: {
    exceptionType: ReconciliationExceptionType;
    paymentAttemptId: string;
    providerEventId: string;
    details: unknown;
  }): Promise<ReconciliationExceptionRecord | null> {
    const db = this.injectedDb;
    if (!this.testHooks?.afterInsertBeforeCommit) {
      const rows = await db
        .insert(reconciliationException)
        .values(input)
        .onConflictDoNothing({
          target: [reconciliationException.paymentAttemptId, reconciliationException.providerEventId, reconciliationException.exceptionType],
          where: sql`${reconciliationException.status} = 'open'`,
        })
        .returning();
      return rows[0] ? toRecord(rows[0]) : null;
    }
    // Test-only path (see `ReconciliationExceptionInsertTestHooks`'s own doc comment) — an explicit
    // transaction so the caller's hook can pause AFTER the insert is issued but BEFORE commit,
    // deterministically proving a concurrent insert attempt genuinely contends with this one.
    const hooks = this.testHooks;
    return db.transaction(async (tx) => {
      const rows = await tx
        .insert(reconciliationException)
        .values(input)
        .onConflictDoNothing({
          target: [reconciliationException.paymentAttemptId, reconciliationException.providerEventId, reconciliationException.exceptionType],
          where: sql`${reconciliationException.status} = 'open'`,
        })
        .returning();
      await hooks.afterInsertBeforeCommit!();
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  async resolve(id: string, resolvedByUserId: string, resolutionReason: string): Promise<ReconciliationExceptionRecord> {
    const db = this.injectedDb;
    const [row] = await db
      .update(reconciliationException)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedByUserId, resolutionReason })
      .where(eq(reconciliationException.id, id))
      .returning();
    if (!row) throw new ConfigurationError("reconciliation_exception resolve found no row");
    return toRecord(row);
  }
}
