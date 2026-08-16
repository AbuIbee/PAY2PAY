import { sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/db/client";

/**
 * PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): distributed,
 * horizontally-safe rate limiting. This module previously held an in-memory `Map`-based limiter
 * (Phase 0), documented in its own comment as only limiting requests hitting the same process — a
 * real gap on Vercel, where concurrent requests can land on different serverless instances with no
 * shared memory. `DrizzleRateLimitStore` below replaces it with the existing Postgres database
 * (`src/db/schema/rateLimit.ts`'s `rate_limit_bucket` table) as the shared counter store, using a
 * single atomic `INSERT ... ON CONFLICT (key) DO UPDATE` statement per check — Postgres serializes
 * concurrent upserts to the same key via row-level locking, so two requests racing from two
 * different instances cannot both read and increment the same pre-update count. No new external
 * provider/account was introduced (PRSprint 04 found this codebase has none beyond Supabase); the
 * database every other piece of this app's state already shares is reused here too.
 */

export interface RateLimitStore {
  /**
   * Atomically increments the counter for `key`, resetting it to 1 first if the key's window has
   * elapsed. Returns the count *after* this call's increment, which the caller compares to its own
   * `limit` — the store itself is limit-agnostic (the same key could be checked against different
   * limits by different callers in principle, though in practice every call site uses one fixed
   * limit per key namespace).
   */
  incrementAndCheck(key: string, windowMs: number, now: number): Promise<number>;
}

/** Real implementation, backed by the shared Postgres database. See this file's module doc comment for the concurrency-safety argument. */
export class DrizzleRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Database) {}

  async incrementAndCheck(key: string, windowMs: number, now: number): Promise<number> {
    const nowDate = new Date(now);
    const newResetAt = new Date(now + windowMs);
    const rows = await this.db.execute<{ count: number }>(sql`
      INSERT INTO "rate_limit_bucket" ("key", "count", "reset_at", "updated_at")
      VALUES (${key}, 1, ${newResetAt}, ${nowDate})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_bucket"."reset_at" <= ${nowDate} THEN 1 ELSE "rate_limit_bucket"."count" + 1 END,
        "reset_at" = CASE WHEN "rate_limit_bucket"."reset_at" <= ${nowDate} THEN ${newResetAt} ELSE "rate_limit_bucket"."reset_at" END,
        "updated_at" = ${nowDate}
      RETURNING "count"
    `);
    const row = rows[0];
    if (!row) throw new Error("rate_limit_bucket upsert returned no row");
    return row.count;
  }
}

/** Test-only in-memory store — same semantics as DrizzleRateLimitStore, without a database, for fast unit tests of the limit/window logic itself. Concurrency-safety is a property of the real store's single atomic SQL statement, argued in this file's module doc comment and covered by DrizzleRateLimitStore's own dedicated test asserting it issues exactly one atomic upsert statement, not a separate read-then-write. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  async incrementAndCheck(key: string, windowMs: number, now: number): Promise<number> {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    bucket.count += 1;
    return bucket.count;
  }

  clear(): void {
    this.buckets.clear();
  }
}

let defaultStore: RateLimitStore | null = null;
let testStoreOverride: InMemoryRateLimitStore | null = null;

function getDefaultStore(): RateLimitStore {
  if (testStoreOverride) return testStoreOverride;
  if (!defaultStore) defaultStore = new DrizzleRateLimitStore(getDb());
  return defaultStore;
}

/**
 * Returns true if `key` is still within `limit` requests per `windowMs`, and records this call
 * toward that limit. Returns false once the limit is exceeded for the remainder of the current
 * window. Logs a structured, PII-free abuse event (namespace only — the part of `key` before its
 * first `:`, never the full key, which may embed an email/IP/phone) whenever a request is blocked,
 * so abuse is observable without putting the identifier itself in logs.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const count = await getDefaultStore().incrementAndCheck(key, windowMs, now);
  const allowed = count <= limit;
  if (!allowed) {
    const namespace = key.split(":")[0];
    logger.warn("rate_limit_exceeded", { namespace, limit, windowMs });
  }
  return allowed;
}

/** Test-only escape hatch: swaps in a fresh in-memory store so tests never touch a real database and each test starts with clean rate-limit state. */
export function resetRateLimits(): void {
  testStoreOverride = new InMemoryRateLimitStore();
}
