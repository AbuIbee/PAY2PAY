#!/usr/bin/env node
/**
 * PRSprint 01 (Supabase Migration Reconciliation): deployment-time drift
 * check. Compares the migration files committed in supabase/migrations/
 * against what the linked Supabase project's supabase_migrations.schema_
 * migrations table reports as applied, via `supabase migration list
 * --linked`. Exits non-zero (failing the deploy step it's wired into) if
 * any local migration is missing remotely, or if the remote has any
 * migration timestamp the repo doesn't recognize.
 *
 * Requires SUPABASE_ACCESS_TOKEN (or an already-authenticated CLI session)
 * and a linked project (`supabase link`) or SUPABASE_PROJECT_REF to link
 * against. Intentionally does not apply anything — this is read-only
 * verification. Applying pending migrations remains a deliberate, separate,
 * explicitly-authorized action (see docs/prsprints/PRSPRINT_01_SUPABASE_
 * MIGRATION_RECONCILIATION.md).
 */
import { execFileSync } from "node:child_process";

function fail(message) {
  console.error(`[schema-drift] ${message}`);
  process.exitCode = 1;
}

const isWindows = process.platform === "win32";

function run(args) {
  // Windows requires shell:true to resolve npx.cmd via spawnSync (a known
  // Node.js behavior, not specific to this script); CI runs on Linux, where
  // this stays false and every argument is passed through execFile's own
  // argv array, never shell-interpolated.
  return execFileSync(isWindows ? "npx.cmd" : "npx", ["supabase", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
  });
}

const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!process.env.SUPABASE_ACCESS_TOKEN) {
  console.log("[schema-drift] SUPABASE_ACCESS_TOKEN not set — skipping (no credentials available in this environment).");
  process.exit(0);
}

try {
  if (projectRef) {
    run(["link", "--project-ref", projectRef]);
  }
  const raw = run(["migration", "list", "--linked", "--output-format", "json"]);
  // Supabase CLI's human-readable stdout can precede the JSON line in some
  // versions ("Connecting to remote database..."); the JSON payload is
  // always the final line.
  const jsonLine = raw.trim().split("\n").pop();
  const parsed = JSON.parse(jsonLine);
  const migrations = parsed.migrations ?? [];

  const missingRemotely = migrations.filter((m) => m.local && !m.remote);
  const unexpectedRemotely = migrations.filter((m) => m.remote && !m.local);

  if (missingRemotely.length > 0) {
    fail(
      `${missingRemotely.length} migration(s) exist in the repo but are NOT applied to the linked Supabase project: ` +
        missingRemotely.map((m) => m.local).join(", "),
    );
  }
  if (unexpectedRemotely.length > 0) {
    fail(
      `${unexpectedRemotely.length} migration(s) are applied to the linked Supabase project but do NOT exist in the repo ` +
        `(manual/out-of-band schema change, or a migration file was deleted after being applied): ` +
        unexpectedRemotely.map((m) => m.remote).join(", "),
    );
  }
  if (missingRemotely.length === 0 && unexpectedRemotely.length === 0) {
    console.log(`[schema-drift] OK — ${migrations.length} migrations match exactly between repo and linked Supabase project.`);
  }
} catch (error) {
  const detail = error && typeof error === "object" && "stderr" in error && error.stderr ? String(error.stderr) : String(error);
  fail(`Could not verify migration state: ${detail}`);
}
