#!/usr/bin/env node
/**
 * PRSprint 30 (docs/prsprints/PRSPRINT_30_CI_CD_DEPLOYMENT_GATES_SCHEMA_DRIFT_PREVENTION.md), master-
 * spec item 191: "Run a clean-room deployment test before launch — start from empty database, current
 * repository, ... prove the application can be deployed from scratch." check-schema-drift.mjs proves
 * the repo's migration set matches an *already-provisioned* linked Supabase project; it says nothing
 * about whether that migration set is even internally valid (a syntax error, a bad ordering
 * dependency, a naming collision) — this script proves that, independently, by applying every
 * migration file in `supabase/migrations/`, in order, against a genuinely empty Postgres database.
 *
 * Bootstraps two structural stubs a bare Postgres instance doesn't have but real Supabase provisions
 * via its managed Auth/Storage services, and this app's own migrations reference: the `anon`/
 * `authenticated` roles (every table's `REVOKE ... FROM anon, authenticated`, PRSprint 02's deny-all
 * precedent) and a minimal `storage.buckets` table (the one migration that seeds Storage bucket rows).
 * This is intentionally the *only* Supabase-specific behavior stubbed — confirmed via audit that no
 * migration in this repo references `auth.uid()`/`auth.*` or any other Supabase-managed schema: this
 * app has its own independent session/auth system (src/lib/auth/authService.ts), never Supabase Auth,
 * and every table's RLS is deny-all-by-default with zero CREATE POLICY statements (the app's own DB
 * connection queries as table owner and bypasses RLS regardless — see any recent migration's own doc
 * comment for this established precedent). A stub this narrow cannot silently paper over a real
 * Supabase-specific incompatibility elsewhere; if one existed, this script would fail loudly on it.
 *
 * Requires DATABASE_URL pointing at an empty, disposable database — never run against anything with
 * real data. Exits non-zero on the first failing migration, naming exactly which file failed.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

function fail(message) {
  console.error(`[fresh-migration-test] ${message}`);
  process.exitCode = 1;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail("DATABASE_URL is required — point it at an empty, disposable Postgres database (never one with real data).");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false);
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filenames are timestamp-prefixed — lexical sort is chronological order.

  if (files.length === 0) {
    fail(`No .sql files found in ${migrationsDir}.`);
  } else {
    for (const file of files) {
      try {
        await sql.file(path.join(migrationsDir, file));
      } catch (error) {
        fail(`Migration ${file} failed to apply: ${error instanceof Error ? error.message : String(error)}`);
        break; // stop at the first failure — later files may depend on this one's tables/types.
      }
    }
    if (process.exitCode !== 1) {
      console.log(`[fresh-migration-test] OK — all ${files.length} migrations applied cleanly to an empty database.`);
    }
  }
} finally {
  await sql.end();
}
