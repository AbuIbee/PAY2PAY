import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db/client";

/**
 * R07 (DB integrity & concurrency hardening) — corrective pass (Codex finding B: "true
 * multi-connection Postgres concurrency testing"). `@/db/client`'s `getDb()` is a memoized
 * singleton — every caller in the whole process shares the SAME single `max: 1` connection, so two
 * "concurrent" calls through it can never actually hold two overlapping PostgreSQL transactions;
 * they just queue on one connection. This creates a genuinely separate, independent connection —
 * its own TCP socket, its own backend process on the server — so two of these can hold two REAL,
 * simultaneously-open transactions, which is what proving lock contention/rollback-on-conflict
 * actually requires.
 *
 * Test-only: production code must keep using `getDb()` exclusively. Each call opens a new
 * connection; callers are responsible for calling `.end()` when done (see `closeIsolatedDb`).
 */
export function createIsolatedDb(databaseUrl: string): { db: Database; client: ReturnType<typeof postgres>; close: () => Promise<void> } {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const db = drizzle(client, { schema }) as Database;
  return {
    db,
    // Exposed alongside `db` so tests can run a raw warm-up query (see `warmUp` below) on the exact
    // same underlying connection `db.transaction()` will later reuse (this client's pool is `max: 1`,
    // so every query issued through it — raw or via drizzle — necessarily shares the one physical
    // connection).
    client,
    close: async () => {
      await client.end({ timeout: 1 }).catch(() => {});
    },
  };
}

/**
 * FINAL corrective pass (Codex: R03-C's barrier-based contention test was timing out intermittently
 * — "find the actual reason, do not dismiss as Windows TCP/ephemeral-port pressure"). Root cause: a
 * fresh `createIsolatedDb` client connects lazily — its FIRST query anywhere also pays for the
 * physical TCP connect and Postgres startup/auth handshake. When that first query is the actual
 * "real transaction" under test, that one-time connection-setup cost lands INSIDE the bounded
 * observation window `waitUntilContended`/`waitUntilPidBlockedOnLock` polls for lock-wait evidence —
 * conflating "how long it took this socket to open" with "how long it took to prove lock contention"
 * are two different things, and only the second one is what these tests are supposed to measure.
 * Calling this BEFORE starting any timed race forces the connection to fully establish and returns
 * its real backend pid, so the timed section's very first statement on it is the lock request itself.
 */
export async function warmUp(client: ReturnType<typeof postgres>): Promise<number> {
  const rows = await client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  const row = rows[0];
  if (!row) throw new Error("warmUp: SELECT pg_backend_pid() returned no row");
  return row.pid;
}
