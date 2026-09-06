import postgres from "postgres";

/**
 * R07 (DB integrity & concurrency hardening) — FINAL corrective pass. A deterministic mechanism for
 * proving two operations genuinely overlap inside the real database, rather than merely being
 * *issued* close together in JS and hoping (Codex finding B: "use PostgreSQL advisory locks, explicit
 * transaction barriers... do NOT rely on timing luck, Promise.all alone, or arbitrary sleeps").
 *
 * How it proves overlap: opens a transaction on its own reserved connection and takes the exact same
 * `pg_advisory_xact_lock(hashtext($1), hashtext($2))` the production code under test acquires
 * (`text1`/`text2` must be the identical arguments that call site uses). It then hands control back
 * to the caller, which fires the competing real operation on a SEPARATE connection WITHOUT awaiting
 * it. `waitUntilContended()` polls `pg_stat_activity` on this same reserved connection (a second
 * statement on an already-open transaction/session — Postgres processes a session's statements
 * sequentially, so this can never itself release the held lock) until it observes the competing
 * backend(s) genuinely blocked (`wait_event_type = 'Lock'`) — server-side proof the competing
 * transaction(s) reached the same lock and are waiting for this one to release, not a client-side
 * guess. Only then does `release()` commit (releasing the lock), at which point the competing
 * operation's promise can be awaited and is guaranteed to have raced the holder for real.
 *
 * FINAL corrective pass (Codex: this test was timing out intermittently — "find the actual reason,
 * do not dismiss as Windows TCP/ephemeral-port pressure"): the root cause was in the CALLER, not this
 * mechanism — see `test/postgres/testDb.ts`'s `warmUp` doc comment for the full explanation. This
 * file's own fix is `waitUntilContended` accepting an optional `expectPids` list: when the caller
 * already knows the exact backend pid(s) it's racing (via `warmUp`), checking for those SPECIFIC pids
 * is strictly stronger proof than "any other backend happened to be waiting" (immune to an unrelated
 * background session ever producing a false pass) and gives an exact, actionable diagnostic on
 * timeout instead of a generic one.
 */
export interface AdvisoryLockBarrier {
  /** Server backend pid holding the lock — useful for asserting `pg_stat_activity` excludes it while checking for a contender. */
  holderPid: number;
  /**
   * Polls until the competing backend(s) are observed waiting on this lock (server-side proof of
   * contention). When `expectPids` is given, requires EVERY listed pid to show as blocked (the
   * strongest available proof, since the caller obtained those pids itself via `warmUp` and knows
   * exactly which real connections must be contending); otherwise accepts any other backend blocked
   * on a lock. Throws — with a full `pg_stat_activity` snapshot attached — on timeout.
   */
  waitUntilContended(opts?: { timeoutMs?: number; expectPids?: number[] }): Promise<void>;
  /** Commits the holder's transaction, releasing the advisory lock. */
  release(): Promise<void>;
}

export async function acquireAdvisoryLockBarrier(databaseUrl: string, text1: string, text2: string): Promise<AdvisoryLockBarrier> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const reserved = await sql.reserve();
  await reserved.unsafe("BEGIN");
  // Acquiring successfully (this call only returns once granted) is itself the proof this
  // connection holds the lock — no separate pg_locks check is needed for that half.
  await reserved`SELECT pg_advisory_xact_lock(hashtext(${text1}), hashtext(${text2}))`;
  const pidRows = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  const pidRow = pidRows[0];
  if (!pidRow) throw new Error("SELECT pg_backend_pid() returned no row");
  const pid = pidRow.pid;

  return {
    holderPid: pid,
    async waitUntilContended({ timeoutMs = 10_000, expectPids }: { timeoutMs?: number; expectPids?: number[] } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (expectPids && expectPids.length > 0) {
          const rows = await reserved<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid = ANY(${expectPids})
          `;
          const seen = new Set(rows.map((r) => r.pid));
          if (expectPids.every((p) => seen.has(p))) return;
        } else {
          // A separate statement on the SAME still-open transaction/connection — Postgres processes
          // statements on one session sequentially, so this does not release the held lock.
          const rows = await reserved<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active' AND pid <> ${pid}
          `;
          if (rows.length > 0) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const diagnostics = await reserved`
        SELECT pid, state, wait_event_type, wait_event, query, (now() - query_start) AS running_for
        FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY pid
      `;
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${expectPids ? `pid(s) [${expectPids.join(", ")}]` : "a contending session"} ` +
          "to show as blocked on the advisory lock via pg_stat_activity.\n" +
          `Full pg_stat_activity snapshot (excluding this poller):\n${JSON.stringify(diagnostics, null, 2)}`,
      );
    },
    async release() {
      await reserved.unsafe("COMMIT");
      reserved.release();
      await sql.end({ timeout: 1 }).catch(() => {});
    },
  };
}

/**
 * FINAL corrective pass (R05-B/R05-C determinism): `waitUntilPidBlockedOnLock` is the row-lock
 * counterpart of `AdvisoryLockBarrier.waitUntilContended`, used alongside the `AgreementLockTestHooks`
 * on `DrizzleSigningApplicationRepository`/`DrizzleRevisionApplicationRepository` (see those classes'
 * own doc comments) rather than a third "fake holder" barrier connection. Those two repositories'
 * transactions each take a real `SELECT ... FOR UPDATE` on the `agreement` row as their first
 * statement — exactly the same row `DrizzleAgreementRepository.updateStatusIfCurrentlyIn`'s single
 * `UPDATE` also needs — so once one real transaction is paused (via its `afterAgreementLock` hook)
 * while genuinely holding that row lock, a second real operation's attempt to acquire the same row
 * genuinely blocks, and this polls `pg_stat_activity` for that SPECIFIC backend pid (obtained via
 * `warmUp`, so it's never ambiguous which connection is being checked) to prove it deterministically
 * rather than assuming it from timing.
 *
 * (An earlier, now-abandoned design used a THIRD "fake holder" connection taking the same row lock
 * directly, mirroring `acquireAdvisoryLockBarrier` — that version produced connections that hung past
 * any reasonable timeout with `pg_stat_activity` never reporting them as waiters. Root-caused: it
 * polled through the SAME `max: 1` client whose one physical connection was already checked out
 * holding the row lock — every "is anyone blocked yet?" poll query needed a connection from that same
 * exhausted pool and queued behind the very transaction it was trying to observe, so it could never
 * complete before the bounded timeout. This function avoids that class of bug entirely by using its
 * own dedicated polling connection, never the connection under test.)
 */
export async function waitUntilPidBlockedOnLock(databaseUrl: string, pid: number, timeoutMs = 10_000): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = await sql<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`;
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const diagnostics = await sql`
      SELECT pid, state, wait_event_type, wait_event, query, (now() - query_start) AS running_for
      FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY pid
    `;
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for pid ${pid} to show as blocked on a lock via pg_stat_activity.\n` +
        `Full pg_stat_activity snapshot (excluding this poller):\n${JSON.stringify(diagnostics, null, 2)}`,
    );
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
