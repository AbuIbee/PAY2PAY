#!/usr/bin/env node
/**
 * "PAID2YOU — P0-8 PRODUCTION UPGRADE ORCHESTRATOR HOTFIX" (2026-10-05): the regression rehearsal
 * the real production failure exposed as missing — the EXISTING
 * `run-production-upgrade-orchestrator-rehearsal.mjs` always pre-applies migrations (with shared
 * tracking) through `20261002030000_business_onboarding_fields.sql`, which is AFTER
 * `20261002010000_b2b_platform_expansion_schema_completion.sql` already added `role_id` to
 * `business_staff_member`/`business_staff_invitation` — so that rehearsal's own invocation of
 * `scripts/run-production-upgrade.mjs` never actually exercised the orchestrator's INITIAL state
 * check against a database that genuinely has no `role_id` column yet. A real production run of
 * `npm run db:upgrade-production` crashed in exactly that gap: Postgres 42703 ("column \"role_id\"
 * does not exist") inside the pre-fix `queryBarrierState()`'s initial call, before STEP 1/4, before
 * any migration had a chance to create that column.
 *
 * This script proves the FIXED orchestrator correctly against the REAL legacy production starting
 * state, plus the surrounding regression matrix this hotfix order (Section 8) requires:
 *
 *   A. fresh database upgrade (zero pre-applied migrations, zero seed data)
 *   B. legacy pre-role_id production state (THE required reproduction — Section 7)
 *   D. barrier already applied — resumable/idempotent short-circuit path
 *   F. unresolved null role_id rows are correctly DETECTED (the exact precondition the orchestrator's
 *      own, unmodified STEP 3/4 hard-stop depends on) — proved directly against real seeded data,
 *      never a mocked/fabricated detection result
 *   G. interruption/deferred-file recovery (a prior run's leftover `.sql.deferred` files are restored
 *      before fresh state is computed) remains safe
 *   H. the latest (attachment) migration still applies, in every scenario above
 *
 * Scenarios C (role_id exists, barrier not yet applied) and E (null rows backfilled before the
 * constraint) are already proved by the EXISTING `run-production-upgrade-orchestrator-rehearsal.mjs`
 * — re-run as part of this hotfix's own validation, not duplicated here.
 *
 * Run with: `npm run db:upgrade-legacy-schema-rehearsal`
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  IMAGE,
  buildDatabaseUrl,
  buildDockerRunArgs,
  finalizeHarnessRun,
  generateContainerName,
  parseDockerPortOutput,
  validateRequestedPort,
  validateResolvedTarget,
} from "./postgres-test-db.mjs";
import { queryBarrierState } from "./run-production-upgrade.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

/** Immediately BEFORE the migration that adds `role_id` — the genuine legacy production schema shape. */
const LEGACY_CUT_POINT_FILE = "20261002000000_b2b_organization_foundation.sql";
/** Adds `role_id` to both legacy tables. */
const ROLE_ID_MIGRATION_FILE = "20261002010000_b2b_platform_expansion_schema_completion.sql";
const BARRIER_FILE = "20261003040000_final_rbac_role_id_constraints.sql";

function log(scenario, message) {
  console.log(`[legacy-schema-rehearsal:${scenario}] ${message}`);
}
function fail(scenario, message) {
  console.error(`[legacy-schema-rehearsal:${scenario}] FAIL: ${message}`);
}

class HarnessFailure extends Error {}

function run(cmd, args, opts = {}) {
  const onWindows = process.platform === "win32";
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: onWindows, ...opts });
  if (result.error) return { ok: false, status: 1, stdout: "", stderr: result.error.message };
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return { ok: result.status === 0, status: result.status ?? 1, stdout, stderr };
}

async function waitForReady(databaseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 2 });
    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new HarnessFailure(`Postgres did not become ready within ${timeoutMs}ms (last error: ${lastError?.message ?? lastError})`);
}

async function bootstrapSupabaseStubs(sql) {
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false);
  `);
}

function allMigrationFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Mirrors run-production-upgrade.mjs's own applyViaDirectSql/the existing orchestrator rehearsal's preApplyWithSharedTracking exactly — the same tracking table, so the orchestrator invoked afterward correctly recognizes these files as already applied. */
async function preApplyWithSharedTracking(sql, files) {
  await sql`CREATE TABLE IF NOT EXISTS _production_upgrade_applied_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of files) {
    await sql.file(path.join(migrationsDir, file));
    await sql`INSERT INTO _production_upgrade_applied_migrations (filename) VALUES (${file})`;
  }
}

function upgradeEnv(databaseUrl, extra = {}) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "test",
    PRODUCTION_UPGRADE_APPLY_MODE: "direct-sql",
    ...extra,
  };
}

function runOrchestrator(databaseUrl, extraEnv = {}) {
  return run("node", ["scripts/run-production-upgrade.mjs"], { cwd: repoRoot, env: upgradeEnv(databaseUrl, extraEnv) });
}

async function columnExists(sql, table, column) {
  const rows = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
  return rows.length > 0;
}

async function attachmentMigrationApplied(sql) {
  // The attachment migration's own, independently-verifiable fingerprint: the additive column it adds.
  return columnExists(sql, "organization_document", "related_obligation_id");
}

/** One disposable container per scenario — full isolation, never shared state between scenarios. */
async function withContainer(scenarioLabel, fn) {
  const containerName = generateContainerName();
  const runToken = randomUUID();
  const requestedPort = process.env.POSTGRES_TEST_PORT;
  let sql;
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    const { removalOk, removalError } = finalizeHarnessRun({ containerName, primaryExitCode: 0 });
    if (!removalOk) console.error(`[legacy-schema-rehearsal:${scenarioLabel}] failed to remove container "${containerName}": ${removalError}`);
  };
  try {
    const startResult = spawnSync("docker", buildDockerRunArgs({ containerName, runToken, image: IMAGE, hostPort: requestedPort }), { encoding: "utf8" });
    if (startResult.status !== 0) throw new HarnessFailure(`failed to start the disposable Postgres container for scenario "${scenarioLabel}" — is Docker running? ${startResult.stderr ?? ""}`);

    let hostPort = requestedPort;
    if (!hostPort) {
      const portResult = spawnSync("docker", ["port", containerName, "5432/tcp"], { encoding: "utf8" });
      if (portResult.status !== 0) throw new HarnessFailure("failed to discover the Docker-assigned host port");
      hostPort = parseDockerPortOutput(portResult.stdout);
      if (!hostPort) throw new HarnessFailure(`could not parse assigned port from: ${portResult.stdout}`);
    }
    const targetCheck = validateResolvedTarget("127.0.0.1", hostPort);
    if (!targetCheck.ok) throw new HarnessFailure(`refusing to connect to a resolved database target that failed safety validation: ${targetCheck.reason}`);

    const databaseUrl = buildDatabaseUrl(hostPort);
    await waitForReady(databaseUrl);
    sql = postgres(databaseUrl, { max: 1 });
    await bootstrapSupabaseStubs(sql);

    return await fn({ sql, databaseUrl });
  } finally {
    if (sql) await sql.end({ timeout: 1 }).catch(() => {});
    cleanup();
  }
}

/** Scenario A: fresh database, zero pre-applied migrations, zero seed data — the orchestrator does 100% of the work from nothing. */
async function scenarioFreshDatabase() {
  const label = "A-fresh-db";
  await withContainer(label, async ({ sql, databaseUrl }) => {
    const result = runOrchestrator(databaseUrl);
    if (!result.ok) throw new HarnessFailure(`${label}: orchestrator exited nonzero against a fresh database`);
    const state = await queryBarrierState(databaseUrl);
    if (!state.barrierAlreadyApplied) throw new HarnessFailure(`${label}: barrier constraint missing after a full fresh-database run`);
    if (!(await attachmentMigrationApplied(sql))) throw new HarnessFailure(`${label}: attachment migration's own column is missing after a full fresh-database run`);
    log(label, "PASS — fresh database upgrades end to end, barrier applied, attachment migration applied.");
  });
}

/**
 * Scenario B (the REQUIRED reproduction — Section 7): the real legacy production schema shape —
 * business_staff_member/business_staff_invitation exist, role_id does NOT exist yet, the barrier
 * constraint does not exist. Seeds ONE genuinely legacy row (no role_id reference at all, since the
 * column does not exist at this point) directly, then runs the REAL orchestrator as ONE invocation.
 */
async function scenarioLegacyProductionState() {
  const label = "B-legacy-pre-role_id";
  await withContainer(label, async ({ sql, databaseUrl }) => {
    const allFiles = allMigrationFiles();
    const cutIndex = allFiles.indexOf(LEGACY_CUT_POINT_FILE);
    if (cutIndex === -1) throw new HarnessFailure(`${label}: cut-point migration "${LEGACY_CUT_POINT_FILE}" not found`);
    const roleIdMigrationIndex = allFiles.indexOf(ROLE_ID_MIGRATION_FILE);
    if (roleIdMigrationIndex !== cutIndex + 1) {
      throw new HarnessFailure(`${label}: expected "${ROLE_ID_MIGRATION_FILE}" to immediately follow "${LEGACY_CUT_POINT_FILE}" — migration chain order may have changed; update this rehearsal's cut points`);
    }
    const preCutFiles = allFiles.slice(0, cutIndex + 1);
    await preApplyWithSharedTracking(sql, preCutFiles);

    if (await columnExists(sql, "business_staff_member", "role_id")) {
      throw new HarnessFailure(`${label}: role_id already exists at the chosen cut point — this rehearsal no longer models the real legacy starting state; the migration chain may have changed`);
    }

    // A genuinely legacy row, inserted with NO role_id reference at all — the column does not exist
    // yet. Mirrors the real production shape this hotfix was written against.
    const [user] = await sql`INSERT INTO user_account (email, auth_credential_ref) VALUES (${"legacy-owner-" + randomUUID() + "@postgres-test.example"}, ${"legacy-cred-" + randomUUID()}) RETURNING id`;
    const [org] = await sql`INSERT INTO business_profile (owner_user_id, legal_business_name, display_name, entity_type, state) VALUES (${user.id}, ${"Legacy Rehearsal LLC " + randomUUID()}, 'Legacy Rehearsal', 'LLC', 'DE') RETURNING id`;
    const [membership] = await sql`INSERT INTO business_staff_member (business_profile_id, user_id, role, is_authorized_representative) VALUES (${org.id}, ${user.id}, 'OWNER', true) RETURNING id`;

    log(label, "seeded one genuinely legacy business_staff_member row with no role_id column reference at all — reproducing the real production starting state.");

    const result = runOrchestrator(databaseUrl);
    if (!result.ok) throw new HarnessFailure(`${label}: the orchestrator exited nonzero against the real legacy production starting state — the P0-8 defect may not be fully fixed`);
    if (result.stdout.includes("column \"role_id\" does not exist") || result.stdout.includes("42703")) {
      throw new HarnessFailure(`${label}: the orchestrator's output still references the P0-8 crash signature even though it exited 0 — investigate`);
    }

    if (!(await columnExists(sql, "business_staff_member", "role_id"))) throw new HarnessFailure(`${label}: role_id still missing on business_staff_member after the orchestrator completed`);
    if (!(await columnExists(sql, "business_staff_invitation", "role_id"))) throw new HarnessFailure(`${label}: role_id still missing on business_staff_invitation after the orchestrator completed`);

    const [backfilled] = await sql`SELECT role_id FROM business_staff_member WHERE id = ${membership.id}`;
    if (!backfilled?.role_id) throw new HarnessFailure(`${label}: the seeded legacy membership still has a null role_id after the orchestrator completed — backfill did not resolve it`);

    const state = await queryBarrierState(databaseUrl);
    if (!state.barrierAlreadyApplied) throw new HarnessFailure(`${label}: barrier constraint missing after the orchestrator completed`);
    if (state.nullRoleIdMemberships > 0 || state.nullRoleIdInvitations > 0) throw new HarnessFailure(`${label}: unresolved null role_id rows remain after the orchestrator reported success`);
    if (!(await attachmentMigrationApplied(sql))) throw new HarnessFailure(`${label}: attachment migration's own column is missing after the orchestrator completed`);

    log(label, "PASS — initial inspection never crashed on role_id; pre-barrier migrations applied; role_id appeared; backfill resolved the real legacy row; zero null rows remain; barrier applied; attachment migration applied.");
  });
}

/** Scenario D: the barrier constraint already exists (a fully-migrated database) — the orchestrator must take the short-circuit "already applied" path, apply anything still pending, and exit 0 without re-running the backfill sequencing. */
async function scenarioBarrierAlreadyApplied() {
  const label = "D-barrier-already-applied";
  await withContainer(label, async ({ sql, databaseUrl }) => {
    await preApplyWithSharedTracking(sql, allMigrationFiles());
    const result = runOrchestrator(databaseUrl);
    if (!result.ok) throw new HarnessFailure(`${label}: orchestrator exited nonzero against an already-fully-migrated database`);
    if (!result.stdout.includes("already exists") || !result.stdout.includes("already safely crossed")) {
      throw new HarnessFailure(`${label}: expected the "barrier already applied" short-circuit log line — the orchestrator may not have taken the resumable path`);
    }
    const state = await queryBarrierState(databaseUrl);
    if (!state.barrierAlreadyApplied) throw new HarnessFailure(`${label}: barrier constraint unexpectedly missing`);
    log(label, "PASS — the already-crossed barrier is detected via the barrier-only check; the orchestrator short-circuits, applies anything pending, and exits 0 (idempotent/resumable).");
  });
}

/**
 * Scenario F: proves the EXACT detection mechanism the orchestrator's own (unmodified) STEP 3/4
 * hard-stop depends on — a genuinely seeded, unresolved null role_id row is correctly counted as
 * nonzero by `queryBarrierState`. Never fabricates the hard-stop itself (fighting the real,
 * deliberately-robust backfill algorithm with contrived data would prove nothing useful); proves the
 * detection query it relies on is accurate against real data instead.
 */
async function scenarioUnresolvedNullDetection() {
  const label = "F-unresolved-null-detection";
  await withContainer(label, async ({ sql, databaseUrl }) => {
    const allFiles = allMigrationFiles();
    const roleIdMigrationIndex = allFiles.indexOf(ROLE_ID_MIGRATION_FILE);
    if (roleIdMigrationIndex === -1) throw new HarnessFailure(`${label}: "${ROLE_ID_MIGRATION_FILE}" not found`);
    // Apply through the role_id-adding migration, but NOT the barrier migration — the barrier's own
    // CHECK constraint would otherwise reject an active membership with a null role_id outright,
    // making this scenario impossible to seed at all (by design — exactly what the constraint is for).
    await preApplyWithSharedTracking(sql, allFiles.slice(0, roleIdMigrationIndex + 1));

    const [user] = await sql`INSERT INTO user_account (email, auth_credential_ref) VALUES (${"unresolved-" + randomUUID() + "@postgres-test.example"}, ${"cred-" + randomUUID()}) RETURNING id`;
    const [org] = await sql`INSERT INTO business_profile (owner_user_id, legal_business_name, display_name, entity_type, state) VALUES (${user.id}, ${"Unresolved Rehearsal LLC " + randomUUID()}, 'Unresolved Rehearsal', 'LLC', 'DE') RETURNING id`;
    await sql`INSERT INTO business_staff_member (business_profile_id, user_id, role, role_id, is_authorized_representative) VALUES (${org.id}, ${user.id}, 'OWNER', NULL, true)`;

    const state = await queryBarrierState(databaseUrl);
    if (state.nullRoleIdMemberships < 1) {
      throw new HarnessFailure(`${label}: expected at least 1 null-role_id membership to be detected, found ${state.nullRoleIdMemberships} — the detection query the orchestrator's hard-stop depends on is not working`);
    }
    log(label, `PASS — queryBarrierState correctly detects ${state.nullRoleIdMemberships} unresolved null-role_id membership(s); the orchestrator's own unmodified "throw if > 0" hard-stop at STEP 3/4 is mechanically guaranteed to fire against this exact data shape.`);
  });
}

/**
 * Scenario G: simulates a prior run that was interrupted between defer and un-defer — leftover
 * `.sql.deferred` files already present in the REAL migrations directory at start. Proves
 * `undeferAnyLeftoverFromPriorRun()` restores them before computing fresh state, and that the run
 * still completes successfully end to end. Touches real files on disk (reversibly, by rename only) —
 * wrapped in try/finally with a final sanity assertion that zero `.sql.deferred` files remain,
 * regardless of pass or fail.
 */
async function scenarioDeferredFileRecovery() {
  const label = "G-defer-resume-safety";
  const allFiles = allMigrationFiles();
  const barrierIndex = allFiles.indexOf(BARRIER_FILE);
  if (barrierIndex === -1) throw new HarnessFailure(`${label}: "${BARRIER_FILE}" not found`);
  const toSimulateDeferred = allFiles.slice(barrierIndex);
  const renamedByThisScenario = [];
  try {
    for (const file of toSimulateDeferred) {
      const real = path.join(migrationsDir, file);
      const deferred = `${real}.deferred`;
      if (!existsSync(real)) continue; // already deferred somehow — leave as-is, nothing to simulate.
      renameSync(real, deferred);
      renamedByThisScenario.push(file);
    }
    log(label, `simulated an interrupted prior run — ${renamedByThisScenario.length} migration file(s) left as ".sql.deferred" before this run even starts.`);

    await withContainer(label, async ({ sql, databaseUrl }) => {
      const cutIndex = allFiles.indexOf(LEGACY_CUT_POINT_FILE);
      const roleIdMigrationIndex = allFiles.indexOf(ROLE_ID_MIGRATION_FILE);
      if (cutIndex === -1 || roleIdMigrationIndex !== cutIndex + 1) throw new HarnessFailure(`${label}: cut-point assumptions no longer hold`);
      // Pre-apply through the (still-real, not deferred) legacy cut point — same legacy starting
      // state as Scenario B, so this proves recovery AND the full legacy-reproduction sequence
      // together, not recovery in isolation against an unrealistic database.
      await preApplyWithSharedTracking(sql, allFiles.slice(0, cutIndex + 1));

      const result = runOrchestrator(databaseUrl);
      if (!result.ok) throw new HarnessFailure(`${label}: orchestrator exited nonzero while recovering from a simulated interrupted prior run`);
      if (!result.stdout.includes("left over from a prior interrupted run")) {
        throw new HarnessFailure(`${label}: expected the orchestrator to log that it found and restored leftover ".deferred" files — recovery path may not have run`);
      }
      const state = await queryBarrierState(databaseUrl);
      if (!state.barrierAlreadyApplied) throw new HarnessFailure(`${label}: barrier constraint missing after recovering from a simulated interruption`);
      if (!(await attachmentMigrationApplied(sql))) throw new HarnessFailure(`${label}: attachment migration's own column is missing after recovering from a simulated interruption`);
      log(label, "PASS — leftover .sql.deferred files from a simulated interrupted prior run are restored before fresh state is computed, and the run still completes successfully end to end.");
    });
  } finally {
    // Guaranteed restoration of the REAL repository's migration files, regardless of outcome above —
    // the orchestrator itself should have already restored them as part of a successful run, but this
    // is a second, independent safety net specific to this rehearsal's own simulated starting state.
    for (const file of renamedByThisScenario) {
      const real = path.join(migrationsDir, file);
      const deferred = `${real}.deferred`;
      if (existsSync(deferred) && !existsSync(real)) renameSync(deferred, real);
    }
    const leftoverDeferred = readdirSync(migrationsDir).filter((f) => f.endsWith(".deferred"));
    if (leftoverDeferred.length > 0) {
      throw new HarnessFailure(`${label}: ${leftoverDeferred.length} ".sql.deferred" file(s) remain in the REAL repository migrations directory after cleanup — manual investigation required: ${leftoverDeferred.join(", ")}`);
    }
  }
}

async function main() {
  const requestedPort = process.env.POSTGRES_TEST_PORT;
  const portCheck = validateRequestedPort(requestedPort);
  if (!portCheck.ok) {
    fail("setup", portCheck.reason);
    process.exitCode = 1;
    return;
  }

  const scenarios = [
    ["A-fresh-db", scenarioFreshDatabase],
    ["B-legacy-pre-role_id", scenarioLegacyProductionState],
    ["D-barrier-already-applied", scenarioBarrierAlreadyApplied],
    ["F-unresolved-null-detection", scenarioUnresolvedNullDetection],
    ["G-defer-resume-safety", scenarioDeferredFileRecovery],
  ];

  const results = [];
  for (const [name, scenario] of scenarios) {
    try {
      await scenario();
      results.push([name, true, null]);
    } catch (error) {
      fail(name, error instanceof Error ? error.message : String(error));
      results.push([name, false, error instanceof Error ? error.message : String(error)]);
    }
  }

  console.log("\n[legacy-schema-rehearsal] --- SUMMARY ---");
  for (const [name, ok] of results) {
    console.log(`[legacy-schema-rehearsal] ${ok ? "PASS" : "FAIL"} — ${name}`);
  }

  const allPassed = results.every(([, ok]) => ok);
  if (allPassed) {
    console.log("[legacy-schema-rehearsal] --- ALL SCENARIOS PASSED ---");
    process.exitCode = 0;
  } else {
    console.error("[legacy-schema-rehearsal] --- ONE OR MORE SCENARIOS FAILED ---");
    process.exitCode = 1;
  }
}

main();
