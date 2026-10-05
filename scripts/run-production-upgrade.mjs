#!/usr/bin/env node
/**
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION", P0-1: the ONE explicit production upgrade command that
 * GUARANTEES the legacy organization-role backfill runs BEFORE
 * `20261003040000_final_rbac_role_id_constraints.sql` ever reaches the database — closing the real
 * deployment-ordering defect Codex found in the previously-documented runbook (which applied every
 * pending migration, including this one, BEFORE the separately-documented backfill step).
 *
 * SEQUENCE (matches docs/PRODUCTION_LAUNCH_RUNBOOK.md's own updated step 4/5):
 *   1. Detect current migration position directly from the database schema itself (never from a
 *      second, possibly-stale bookkeeping source) — specifically, whether
 *      `business_staff_member_active_role_id_required` already exists. If it does, the barrier has
 *      already been safely crossed; this script applies anything still pending and exits.
 *   2. If the barrier has NOT been crossed yet: temporarily DEFER (rename `.sql` -> `.sql.deferred`,
 *      reversible, never destructive) every migration file from
 *      `20261003040000_final_rbac_role_id_constraints.sql` onward — so the deploy mechanism that
 *      scans `supabase/migrations/` (the real `supabase db push --linked`, by default) cannot apply
 *      the barrier migration (or anything after it) yet, no matter what else runs concurrently.
 *   3. Apply only the now-visible (pre-barrier) migrations.
 *   4. Un-defer the held-back files.
 *   5. Run the REAL backfill (`npm run db:backfill-legacy-roles`'s own script, not a reimplementation).
 *   6. VERIFY, by direct query, that zero active memberships / pending invitations remain with a null
 *      role_id. Fails loudly (nonzero exit) and does NOT proceed if any remain — never silently
 *      continues into a migration that would then fail anyway.
 *   7. Apply the now-un-deferred remaining migrations (the barrier migration included).
 *   8. Final verification: the barrier constraint now exists; zero null-role_id rows remain.
 *
 * Every step is idempotent and resumable: if this script is interrupted between steps 2-4, a later
 * invocation finds `.sql.deferred` files already present and resumes correctly rather than
 * re-deferring (or double-deferring) anything.
 *
 * "PAID2YOU — P0-8 PRODUCTION UPGRADE ORCHESTRATOR HOTFIX" (2026-10-05): the initial state check
 * (step 1 above) determines ONLY whether the barrier constraint already exists —
 * `queryBarrierApplied` — and never reads `role_id` at all. On a genuine legacy production
 * database, `business_staff_member`/`business_staff_invitation` already exist but their `role_id`
 * columns do not — those are introduced by a pre-barrier migration, so querying them before step 3
 * crashed with Postgres 42703 ("column does not exist") before the orchestrator ever reached the
 * migrations that create it. `verifyRoleIdColumnsExist` runs immediately after pre-barrier
 * migrations apply (and before any `role_id`-reading query) and hard-stops with a clear
 * `UpgradeFailure` — never a silently-assumed zero count — if a required table exists but its
 * `role_id` column is still missing at that point, which would indicate a genuine migration-ordering
 * failure rather than this orchestrator's own precondition being wrong.
 *
 * APPLY MECHANISM: defaults to the REAL production path, `npx supabase db push --linked` — this
 * script never bypasses or duplicates Supabase's own migration-tracking. For this repository's own
 * disposable-Postgres rehearsal (no linked Supabase project exists for a throwaway container — see
 * scripts/run-production-upgrade-rehearsal.mjs), set `PRODUCTION_UPGRADE_APPLY_MODE=direct-sql` to
 * substitute this repo's own already-proven raw-SQL-file applier (identical mechanism
 * apply-migrations-fresh.mjs/postgres-test-db.mjs already use) against `DATABASE_URL` directly — the
 * ordering/gating/verification logic exercised is byte-identical either way; only "how is a batch of
 * files physically applied" differs, which is the same documented distinction this repository already
 * draws between disposable-test and real-production migration application.
 *
 * Run with (production): `npm run db:upgrade-production` (requires DATABASE_URL and a linked Supabase
 * project — `supabase link`/SUPABASE_PROJECT_REF — exactly like `scripts/check-schema-drift.mjs`).
 * Never run by Claude against a real production database — this script is for the OWNER to run during
 * the documented launch runbook, with real deployment credentials Claude does not have.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const BARRIER_FILE = "20261003040000_final_rbac_role_id_constraints.sql";
const BARRIER_CONSTRAINT_NAME = "business_staff_member_active_role_id_required";
const DEFERRED_SUFFIX = ".deferred";

function log(message) {
  console.log(`[upgrade-production] ${message}`);
}

function fail(message) {
  console.error(`[upgrade-production] FAIL: ${message}`);
}

class UpgradeFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function currentMigrationFiles() {
  // Only real `.sql` files are "currently applicable" — a `.sql.deferred` file is, by design,
  // invisible to whatever applies migrations (real Supabase CLI or this script's own test applier).
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function deferredFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(DEFERRED_SUFFIX))
    .sort();
}

/** Reversible — renames, never deletes or edits migration content. Idempotent: skips files already deferred. */
function deferFromBarrierOnward() {
  const files = currentMigrationFiles();
  const barrierIndex = files.indexOf(BARRIER_FILE);
  if (barrierIndex === -1) {
    // Already deferred (or this is a resumed run) — nothing further to defer.
    return [];
  }
  const toDefer = files.slice(barrierIndex);
  for (const file of toDefer) {
    renameSync(path.join(migrationsDir, file), path.join(migrationsDir, `${file}${DEFERRED_SUFFIX}`));
  }
  log(`deferred ${toDefer.length} migration file(s) from "${BARRIER_FILE}" onward (reversible rename, not a content change)`);
  return toDefer;
}

function undefer(deferredList) {
  for (const deferredName of deferredList) {
    const current = path.join(migrationsDir, `${deferredName}${DEFERRED_SUFFIX}`);
    if (existsSync(current)) {
      renameSync(current, path.join(migrationsDir, deferredName));
    }
  }
  log(`restored ${deferredList.length} deferred migration file(s) to their real names`);
}

/** Resumability: picks up `.sql.deferred` files from a prior interrupted run, restoring them before computing fresh state. */
function undeferAnyLeftoverFromPriorRun() {
  const leftover = deferredFiles();
  if (leftover.length === 0) return;
  log(`found ${leftover.length} "${DEFERRED_SUFFIX}" file(s) left over from a prior interrupted run — restoring before proceeding`);
  for (const deferredFile of leftover) {
    const realName = deferredFile.slice(0, -DEFERRED_SUFFIX.length);
    renameSync(path.join(migrationsDir, deferredFile), path.join(migrationsDir, realName));
  }
}

function runCapture(cmd, args, opts = {}) {
  const onWindows = process.platform === "win32";
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: "inherit", shell: onWindows, ...opts });
  if (result.error) return { ok: false, error: result.error };
  return { ok: result.status === 0, status: result.status };
}

/** The REAL production apply mechanism — never bypassed or duplicated. */
function applyViaSupabaseCli() {
  log("applying pending migrations via `npx supabase db push --linked` (the real production mechanism)...");
  const result = runCapture("npx", ["supabase", "db", "push", "--linked"]);
  if (!result.ok) throw new UpgradeFailure("`supabase db push --linked` failed — see output above. Nothing further was attempted.");
}

/**
 * Test-only substitute for the disposable-Postgres rehearsal (no linked Supabase project exists for a
 * throwaway container). Applies exactly the given files, in order, via this repository's own
 * already-proven raw-SQL-file mechanism (identical to apply-migrations-fresh.mjs) — with its own
 * lightweight tracking table so repeated invocations never re-apply an already-applied file (the
 * SAME "detect position, never reapply" guarantee the real `supabase db push --linked` already gives
 * for free via its own remote tracking — this table exists ONLY so the test applier can honestly prove
 * that same guarantee without a real linked Supabase project).
 */
async function applyViaDirectSql(files) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new UpgradeFailure("PRODUCTION_UPGRADE_APPLY_MODE=direct-sql requires DATABASE_URL to be set.");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _production_upgrade_applied_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const file of files) {
      const already = await sql`SELECT 1 FROM _production_upgrade_applied_migrations WHERE filename = ${file}`;
      if (already.length > 0) {
        log(`[direct-sql test applier] already applied, skipping: ${file}`);
        continue;
      }
      log(`[direct-sql test applier] applying: ${file}`);
      await sql.file(path.join(migrationsDir, file));
      await sql`INSERT INTO _production_upgrade_applied_migrations (filename) VALUES (${file})`;
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function applyMigrations(explicitFilesForTestApplier) {
  if (process.env.PRODUCTION_UPGRADE_APPLY_MODE === "direct-sql") {
    await applyViaDirectSql(explicitFilesForTestApplier);
    return;
  }
  applyViaSupabaseCli();
}

/**
 * "PAID2YOU — P0-8 PRODUCTION UPGRADE ORCHESTRATOR HOTFIX" (2026-10-05): the ONLY state fact that is
 * ever safe to ask BEFORE any pre-barrier migration has run — whether the final barrier constraint
 * already exists. Deliberately never touches `role_id` at all: on a legacy production database, the
 * `business_staff_member`/`business_staff_invitation` tables already exist, but their `role_id`
 * columns do not yet — those are introduced by a pre-barrier migration. Querying `role_id` here (the
 * P0-8 defect) crashed with Postgres 42703 ("column does not exist") before the orchestrator ever
 * reached the migrations that create it.
 */
async function queryBarrierApplied(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const constraintRows = await sql`
      SELECT 1 FROM pg_constraint WHERE conname = ${BARRIER_CONSTRAINT_NAME}
    `;
    return constraintRows.length > 0;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * P0-8: must be called — and must pass — AFTER pre-barrier migrations have applied and BEFORE any
 * query that reads `role_id` (queryBarrierState below). Never infers "no null role_id rows" from a
 * missing column; a missing column after the pre-barrier phase is a genuine migration-ordering
 * failure and must hard-stop, never be silently treated as a count of zero.
 */
async function verifyRoleIdColumnsExist(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const tablesExist = await sql`
      SELECT to_regclass('public.business_staff_member') AS members, to_regclass('public.business_staff_invitation') AS invitations
    `;
    const requiredTables = [
      { table: "business_staff_member", exists: Boolean(tablesExist[0]?.members) },
      { table: "business_staff_invitation", exists: Boolean(tablesExist[0]?.invitations) },
    ];
    for (const { table, exists } of requiredTables) {
      // A table that does not exist at all yet (e.g. a genuinely fresh database still mid-migration)
      // has no role_id column to verify either way — nothing to check, nothing to hard-stop on.
      if (!exists) continue;
      const columnRows = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'role_id'
      `;
      if (columnRows.length === 0) {
        throw new UpgradeFailure(`pre-barrier migrations completed but required role_id column is still missing on "${table}".`);
      }
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Safe to call ONLY once `verifyRoleIdColumnsExist` has already passed for this run (i.e. after
 * pre-barrier migrations have applied) — every call site below is ordered to guarantee that.
 */
async function queryBarrierState(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const constraintRows = await sql`
      SELECT 1 FROM pg_constraint WHERE conname = ${BARRIER_CONSTRAINT_NAME}
    `;
    const barrierAlreadyApplied = constraintRows.length > 0;

    let nullRoleIdMemberships = 0;
    let nullRoleIdInvitations = 0;
    const tablesExist = await sql`
      SELECT to_regclass('public.business_staff_member') AS members, to_regclass('public.business_staff_invitation') AS invitations
    `;
    if (tablesExist[0]?.members) {
      const rows = await sql`SELECT count(*)::int AS n FROM business_staff_member WHERE removed_at IS NULL AND role_id IS NULL`;
      nullRoleIdMemberships = rows[0]?.n ?? 0;
    }
    if (tablesExist[0]?.invitations) {
      const rows = await sql`SELECT count(*)::int AS n FROM business_staff_invitation WHERE status = 'pending' AND role_id IS NULL`;
      nullRoleIdInvitations = rows[0]?.n ?? 0;
    }
    return { barrierAlreadyApplied, nullRoleIdMemberships, nullRoleIdInvitations };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

function runBackfill(databaseUrl) {
  log("running the REAL legacy-role backfill (npm run db:backfill-legacy-roles)...");
  const result = runCapture("npx", ["tsx", "--conditions=react-server", "scripts/backfill-legacy-organization-roles.ts"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (!result.ok) throw new UpgradeFailure("the legacy-role backfill failed — never proceeding to the role_id-required constraint migration with unresolved data.");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new UpgradeFailure("DATABASE_URL is required.");

  undeferAnyLeftoverFromPriorRun();

  // P0-8: the INITIAL state check must determine ONLY whether the final barrier constraint already
  // exists — it must NEVER require role_id to exist, since on a legacy production database the
  // table exists but the column does not yet (it is introduced by a pre-barrier migration below).
  const barrierAlreadyApplied = await queryBarrierApplied(databaseUrl);
  if (barrierAlreadyApplied) {
    log(`"${BARRIER_CONSTRAINT_NAME}" already exists — the backfill barrier was already safely crossed. Applying anything still pending and exiting.`);
    await applyMigrations(currentMigrationFiles());
    log("--- DONE — nothing pending required the backfill barrier. ---");
    return;
  }

  const allFiles = currentMigrationFiles();
  const barrierIndex = allFiles.indexOf(BARRIER_FILE);
  if (barrierIndex === -1) {
    throw new UpgradeFailure(`"${BARRIER_FILE}" was not found in ${migrationsDir} — migration chain may have changed; this script needs updating before it can run safely.`);
  }
  const preCutFiles = allFiles.slice(0, barrierIndex);
  const deferredNames = deferFromBarrierOnward();

  try {
    log(`--- STEP 1/4: applying ${preCutFiles.length} migration(s) BEFORE the role_id-required barrier ---`);
    await applyMigrations(preCutFiles);
  } finally {
    undefer(deferredNames);
  }

  log("--- verifying the role_id schema actually exists before any null-role_id query runs ---");
  await verifyRoleIdColumnsExist(databaseUrl);

  log(`--- STEP 2/4: checking whether the legacy-role backfill is actually required (real-time query, not a guess) ---`);
  const preBackfill = await queryBarrierState(databaseUrl);
  log(`found ${preBackfill.nullRoleIdMemberships} active membership(s) and ${preBackfill.nullRoleIdInvitations} pending invitation(s) with a null role_id.`);
  // Always run the backfill before the barrier migration — it is documented as a guaranteed no-op
  // when nothing qualifies (every live mutation path resolves role_id explicitly at write time), so
  // running it unconditionally is strictly safer than trying to skip it via a second heuristic that
  // could itself be wrong (Section 5's own "never silently skip a failed backfill").
  runBackfill(databaseUrl);

  log("--- STEP 3/4: verifying the backfill actually resolved every qualifying row — HARD STOP if not ---");
  const postBackfill = await queryBarrierState(databaseUrl);
  if (postBackfill.nullRoleIdMemberships > 0 || postBackfill.nullRoleIdInvitations > 0) {
    throw new UpgradeFailure(
      `the backfill did not resolve every qualifying row (${postBackfill.nullRoleIdMemberships} membership(s), ${postBackfill.nullRoleIdInvitations} invitation(s) still null) — refusing to apply "${BARRIER_FILE}", which would otherwise fail anyway. Investigate before re-running.`,
    );
  }
  log("CONFIRMED: zero active memberships / pending invitations remain with a null role_id.");

  const remainingFiles = allFiles.slice(barrierIndex);
  log(`--- STEP 4/4: applying the remaining ${remainingFiles.length} migration(s), including the role_id-required barrier ---`);
  await applyMigrations(remainingFiles);

  const final = await queryBarrierState(databaseUrl);
  if (!final.barrierAlreadyApplied) {
    throw new UpgradeFailure(`"${BARRIER_CONSTRAINT_NAME}" still does not exist after applying the remaining migrations — the barrier migration may not have actually run.`);
  }
  log(`CONFIRMED: "${BARRIER_CONSTRAINT_NAME}" now exists. PASS — production upgrade complete in the required safe order.`);
}

// "PAID2YOU — P0-8 PRODUCTION UPGRADE ORCHESTRATOR HOTFIX" (2026-10-05): guarded, mirroring
// check-production-readiness.mjs's own identical pattern, so this module can be imported (to exercise
// its exported functions directly from a regression rehearsal) WITHOUT also triggering a real run —
// `main()` only executes when this file is the actual process entry point.
export { queryBarrierApplied, verifyRoleIdColumnsExist, queryBarrierState, UpgradeFailure, BARRIER_FILE, BARRIER_CONSTRAINT_NAME };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      if (error instanceof UpgradeFailure) {
        fail(error.message);
        process.exitCode = error.exitCode || 1;
      } else {
        console.error("[upgrade-production] fatal error:", error);
        process.exitCode = 1;
      }
    });
}
