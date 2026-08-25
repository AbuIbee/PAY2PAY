#!/usr/bin/env node
/**
 * Agreement Lifecycle V2 UAT remediation (Defect 2 root cause): PRSprint 10's `agreement_invitation`
 * table was generated into drizzle/migrations/ (the Drizzle-ORM-schema-derived migration set) but
 * never carried over into supabase/migrations/ (the only set actually applied to the real linked
 * database — see check-schema-drift.mjs's own doc comment) — every INSERT against it failed with
 * postgres 42P01 ("relation does not exist") for the entire time PRSprint 10 was shipped. Neither
 * existing check would have caught this: check-schema-drift.mjs only compares supabase/migrations/
 * against what's *applied remotely*, and check-migration-safety.mjs only scans for destructive
 * statements — nothing compared the two migration directories against each other.
 *
 * Pure static text scanning — no database connection, no external credentials, runs on every push/PR
 * (via `npm run test:tooling`, mirroring check-migration-safety.mjs's own zero-dependency precedent).
 * Only compares CREATE TABLE — drizzle/migrations/ is regenerated wholesale by `db:generate` and can
 * reorder/reformat existing ALTER COLUMN statements in ways that would false-positive a column-level
 * diff; missing tables are the specific, catastrophic failure mode this script exists to catch.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const drizzleMigrationsDir = path.join(__dirname, "..", "drizzle", "migrations");
export const supabaseMigrationsDir = path.join(__dirname, "..", "supabase", "migrations");

const CREATE_TABLE_PATTERN = /CREATE TABLE "([a-z_]+)"/g;

export function extractCreatedTables(sql) {
  const names = new Set();
  for (const match of sql.matchAll(CREATE_TABLE_PATTERN)) {
    names.add(match[1]);
  }
  return names;
}

function collectTablesFromDir(dir) {
  const names = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    const text = readFileSync(path.join(dir, file), "utf8");
    for (const name of extractCreatedTables(text)) names.add(name);
  }
  return names;
}

/** Returns the table names Drizzle's schema created that supabase/migrations/ never mirrors. */
export function findMissingTables(drizzleTables, supabaseTables) {
  return [...drizzleTables].filter((name) => !supabaseTables.has(name)).sort();
}

function main() {
  const drizzleTables = collectTablesFromDir(drizzleMigrationsDir);
  const supabaseTables = collectTablesFromDir(supabaseMigrationsDir);
  const missing = findMissingTables(drizzleTables, supabaseTables);

  if (missing.length > 0) {
    console.error(
      `[drizzle-supabase-sync] ${missing.length} table(s) exist in drizzle/migrations/ (src/db/schema/'s ` +
        `own generated output) but have no corresponding CREATE TABLE in supabase/migrations/ (the set ` +
        `actually applied to the real database): ${missing.join(", ")}. Every query against ` +
        `${missing.length === 1 ? "this table" : "these tables"} will fail with postgres 42P01 ("relation ` +
        `does not exist") against any real deployment. Copy the corresponding drizzle/migrations/*.sql file's ` +
        `content into a new, appropriately-named supabase/migrations/*.sql file, then apply it with ` +
        `\`npx supabase db push --linked\`.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`[drizzle-supabase-sync] OK — every drizzle/migrations/ CREATE TABLE (${drizzleTables.size}) is mirrored in supabase/migrations/.`);
  }
}

// Only run when executed directly (`node scripts/check-drizzle-supabase-sync.mjs`), not when imported
// by its own test file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
