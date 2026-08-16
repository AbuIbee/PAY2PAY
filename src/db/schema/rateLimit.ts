import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): the shared
 * counter store behind `src/lib/rate-limit.ts`'s distributed limiter. Replaces the prior in-memory
 * `Map` (documented in that file's own history as a Phase-0 placeholder that "only limits requests
 * hitting the same process") — this app deploys to Vercel, where each request may land on a
 * different serverless instance with no shared process memory, so an in-memory counter does not
 * actually bound abuse in production. This table is the existing, already-provisioned Postgres
 * database (no new external provider/account — see PRSprint 04's finding that this codebase has no
 * infrastructure beyond Supabase), which every serverless instance already shares.
 *
 * One row per limiter key (e.g. `login:ip:1.2.3.4`, `staff-invite:target:someone@example.com`).
 * `count`/`reset_at` are updated by a single atomic `INSERT ... ON CONFLICT (key) DO UPDATE`
 * statement (see `DrizzleRateLimitStore.incrementAndCheck` in src/lib/rate-limit.ts) — Postgres
 * serializes concurrent upserts to the same key via row-level locking, so two requests racing from
 * two different serverless instances cannot both observe and increment the same pre-update count;
 * this is what makes the limiter genuinely distributed/horizontally-safe, not just "backed by a
 * database" in name only.
 */
export const rateLimitBucket = pgTable(
  "rate_limit_bucket",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(1),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("rate_limit_bucket_count_positive", sql`${table.count} > 0`)],
).enableRLS();
