#!/usr/bin/env node
/**
 * Stage 5 Zero-False-Positive Completion Order — Part III (Steps 11-14): proves DB-09 (migration
 * runner correctness / applied-state tracking), pending-only application, and failure/retry
 * semantics using the AUTHORITATIVE runner for `supabase/migrations/` — the Supabase CLI's own
 * `supabase migration up`, which persists applied state in `supabase_migrations.schema_migrations`
 * on whatever database it targets. `scripts/apply-migrations-fresh.mjs` is deliberately NOT used
 * here (per the order's own Step 11): it applies raw SQL files with no state-tracking table at
 * all, so it cannot serve as evidence for DB-09, pending-only, or retry semantics — only for
 * fresh-build reproducibility (DB-03), which is proven elsewhere (scripts/postgres-test-db.mjs).
 *
 * Three phases, one disposable Postgres 17 container, three separate databases inside it (so
 * each phase starts from a genuinely clean state without paying for three container spin-ups):
 *   1. Applied-state persistence — apply the full real migration set twice; second run applies
 *      zero, state unchanged.
 *   2. Pending-only application — apply a real 57-migration prefix, then grow the workdir to the
 *      full 58 and reapply: the 57 already-applied migrations are not reapplied, the one new
 *      migration is applied and marked exactly once, and a further rerun applies zero.
 *   3. Failure/retry — apply the same 57-migration prefix plus ONE test-owned, deliberately
 *      failing scratch migration (never touching any accepted historical migration or the real
 *      supabase/migrations/ directory): the failure run proves the failed migration's own DDL
 *      does not persist and is not marked applied; the failure condition is then removed and a
 *      retry run proves it applies exactly once, with a further rerun applying zero.
 *
 * Every `supabase migration up` invocation and its schema_migrations follow-up are real,
 * separate child-process/query calls, each producing its own status sidecar via
 * scripts/lib/statusSidecar.mjs — never a hand-typed PASS/FAIL summary.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { runCommandWithSidecar, saveManualSidecar } from "./lib/statusSidecar.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const CUTOFF_FILE = "20260928000000_ledger_entry_type_stage4_parity.sql"; // last pre-Stage-5 migration, same fixed cutoff as Step 10.
const IMAGE = "postgres:17-alpine";
const scratchRoot = path.join(repoRoot, ".stage5-runner-proof-scratch");

function log(message) {
  console.log(`[stage5-runner-proof] ${message}`);
}

function fail(message) {
  console.error(`[stage5-runner-proof] FAIL: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
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

function makeWorkdir(name, migrationFileNames) {
  const dir = path.join(scratchRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
  cpSync(path.join(repoRoot, "supabase", "config.toml"), path.join(dir, "supabase", "config.toml"));
  for (const file of migrationFileNames) {
    cpSync(path.join(migrationsDir, file), path.join(dir, "supabase", "migrations", file));
  }
  return dir;
}

function supabaseMigrationUp(sidecarName, dbUrl, workdir) {
  return runCommandWithSidecar(
    sidecarName,
    "npx",
    ["supabase", "migration", "up", "--db-url", dbUrl, "--workdir", workdir, "--include-all", "--yes"],
    { cwd: repoRoot },
  );
}

async function schemaMigrationsState(sql) {
  try {
    const rows = await sql`SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version`;
    return rows.map((r) => ({ version: r.version, name: r.name }));
  } catch {
    return []; // schema doesn't exist yet (before the first successful run).
  }
}

let containerName;

async function main() {
  const allFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const cutoffIndex = allFiles.indexOf(CUTOFF_FILE);
  assert(cutoffIndex !== -1, `cutoff file ${CUTOFF_FILE} not found`);
  const prefixFiles = allFiles.slice(0, cutoffIndex + 1); // 57 real, pre-Stage-5 migrations.
  const fullFiles = allFiles; // 58, includes the one new Stage 5 migration.
  const newFileName = fullFiles[fullFiles.length - 1];
  log(`prefix set: ${prefixFiles.length} migrations (through ${CUTOFF_FILE}). full set: ${fullFiles.length} migrations. newest: ${newFileName}.`);

  containerName = `pay2pay-s5-runner-${process.pid}-${randomBytes(4).toString("hex")}`;
  log(`starting disposable Postgres container "${containerName}"`);
  const runResult = spawnSync("docker", [
    "run", "-d", "--name", containerName,
    "--label", "pay2pay-test-harness=true",
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=postgres",
    "-p", "127.0.0.1::5432", IMAGE,
  ], { encoding: "utf8" });
  assert(runResult.status === 0, `docker run failed: ${runResult.stderr}`);

  const portOutput = spawnSync("docker", ["port", containerName, "5432/tcp"], { encoding: "utf8" }).stdout;
  const hostPort = /:(\d+)\s*$/m.exec(portOutput.trim().split("\n").pop() ?? "")?.[1];
  assert(hostPort && !["5432", "54322"].includes(hostPort), `bad or forbidden port: ${hostPort}`);
  log(`Postgres reachable at 127.0.0.1:${hostPort}`);

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const probe = postgres(`postgres://postgres:postgres@127.0.0.1:${hostPort}/postgres`, { max: 1, connect_timeout: 2 });
      await probe`SELECT 1`;
      await probe.end({ timeout: 1 });
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert(ready, "Postgres did not become ready in time");

  const inspection = JSON.parse(spawnSync("docker", ["inspect", containerName], { encoding: "utf8" }).stdout)[0];
  assert(inspection?.Name.replace(/^\//, "") === containerName && inspection.Config.Image === IMAGE && inspection.State.Running, "container identity verification failed");
  log(`container identity confirmed (id ${inspection.Id.slice(0, 12)}...)`);

  const results = {};

  // ---- PHASE 1: applied-state persistence (DB-09) --------------------------------------------
  {
    const dbName = "db09_proof";
    const adminSql = postgres(`postgres://postgres:postgres@127.0.0.1:${hostPort}/postgres`, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    await adminSql.end({ timeout: 1 });
    const dbUrl = `postgres://postgres:postgres@127.0.0.1:${hostPort}/${dbName}?sslmode=disable`;
    const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${hostPort}/${dbName}`, { max: 1 });
    await bootstrapSupabaseStubs(sql);

    const workdir = makeWorkdir("db09-full", fullFiles);
    const runA = supabaseMigrationUp("db09-applied-state-run-a", dbUrl, workdir);
    assert(runA.exitCode === 0, `Phase 1 run A failed: ${runA.stderr || runA.stdout}`);
    const stateAfterA = await schemaMigrationsState(sql);
    assert(stateAfterA.length === fullFiles.length, `Phase 1: expected ${fullFiles.length} tracked migrations after run A, got ${stateAfterA.length}`);

    const runB = supabaseMigrationUp("db09-applied-state-run-b", dbUrl, workdir);
    assert(runB.exitCode === 0, `Phase 1 run B (rerun) failed: ${runB.stderr || runB.stdout}`);
    assert(JSON.parse(runB.stdout).applied.length === 0, `Phase 1: rerun should apply zero migrations, got ${runB.stdout}`);
    const stateAfterB = await schemaMigrationsState(sql);
    assert(stateAfterB.length === stateAfterA.length, `Phase 1: tracked migration count changed after no-op rerun: ${stateAfterA.length} -> ${stateAfterB.length}`);
    assert(
      JSON.stringify(stateAfterA.map((r) => r.version)) === JSON.stringify(stateAfterB.map((r) => r.version)),
      "Phase 1: tracked migration identifiers changed after no-op rerun",
    );
    await sql.end({ timeout: 1 });
    results.dbo9AppliedStatePersistence = { runA: runA.exitCode, runB: runB.exitCode, trackedCount: stateAfterB.length };
    log(`PHASE 1 (DB-09 applied-state persistence): PASS — ${stateAfterB.length} migrations tracked, unchanged across a no-op rerun.`);
  }

  // ---- PHASE 2: pending-only application (Step 13) --------------------------------------------
  {
    const dbName = "pending_only_proof";
    const adminSql = postgres(`postgres://postgres:postgres@127.0.0.1:${hostPort}/postgres`, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    await adminSql.end({ timeout: 1 });
    const dbUrl = `postgres://postgres:postgres@127.0.0.1:${hostPort}/${dbName}?sslmode=disable`;
    const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${hostPort}/${dbName}`, { max: 1 });
    await bootstrapSupabaseStubs(sql);

    const workdirPartial = makeWorkdir("pending-only-partial", prefixFiles);
    const runA = supabaseMigrationUp("pending-only-run-a", dbUrl, workdirPartial);
    assert(runA.exitCode === 0, `Phase 2 run A (partial apply) failed: ${runA.stderr || runA.stdout}`);
    const stateAfterPartial = await schemaMigrationsState(sql);
    assert(stateAfterPartial.length === prefixFiles.length, `Phase 2: expected ${prefixFiles.length} tracked after partial apply, got ${stateAfterPartial.length}`);
    const partialVersions = new Set(stateAfterPartial.map((r) => r.version));

    const workdirFull = makeWorkdir("pending-only-full", fullFiles);
    const runB = supabaseMigrationUp("pending-only-run-b", dbUrl, workdirFull);
    assert(runB.exitCode === 0, `Phase 2 run B (apply pending) failed: ${runB.stderr || runB.stdout}`);
    const appliedInB = JSON.parse(runB.stdout).applied;
    assert(appliedInB.length === 1 && appliedInB[0].includes(newFileName), `Phase 2: expected exactly the one new migration to be applied in run B, got ${JSON.stringify(appliedInB)}`);
    const stateAfterFull = await schemaMigrationsState(sql);
    assert(stateAfterFull.length === fullFiles.length, `Phase 2: expected ${fullFiles.length} tracked after applying the pending migration, got ${stateAfterFull.length}`);
    for (const v of partialVersions) {
      assert(stateAfterFull.some((r) => r.version === v), `Phase 2: previously-applied migration ${v} is missing after applying the pending one`);
    }

    const runC = supabaseMigrationUp("pending-only-partial-state-proof", dbUrl, workdirFull);
    assert(runC.exitCode === 0, `Phase 2 run C (rerun at full state) failed: ${runC.stderr || runC.stdout}`);
    assert(JSON.parse(runC.stdout).applied.length === 0, `Phase 2: rerun at full state should apply zero migrations, got ${runC.stdout}`);
    const stateAfterC = await schemaMigrationsState(sql);
    assert(stateAfterC.length === fullFiles.length, `Phase 2: tracked count changed on final idempotent rerun`);

    await sql.end({ timeout: 1 });
    results.pendingOnly = { runA: runA.exitCode, runB: runB.exitCode, runC: runC.exitCode, appliedInB, finalTrackedCount: stateAfterC.length };
    log(`PHASE 2 (pending-only application): PASS — 57 pre-applied migrations untouched, 1 pending migration applied exactly once, further rerun applied zero.`);
  }

  // ---- PHASE 3: failure/retry (Step 14) --------------------------------------------------------
  {
    const dbName = "failure_retry_proof";
    const adminSql = postgres(`postgres://postgres:postgres@127.0.0.1:${hostPort}/postgres`, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    await adminSql.end({ timeout: 1 });
    const dbUrl = `postgres://postgres:postgres@127.0.0.1:${hostPort}/${dbName}?sslmode=disable`;
    const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${hostPort}/${dbName}`, { max: 1 });
    await bootstrapSupabaseStubs(sql);

    const scratchMigrationName = "99999999999999_stage5_test_owned_deliberate_failure.sql";
    const workdirFailure = makeWorkdir("failure-retry", prefixFiles);
    const scratchPath = path.join(workdirFailure, "supabase", "migrations", scratchMigrationName);
    // Test-owned scratch migration — never written to the real supabase/migrations/ directory,
    // never touches any accepted table. Creates one harmless, obviously-scratch table, then
    // deliberately fails via a runtime division-by-zero error so the whole file's transaction
    // (confirmed empirically during this Stage's own remediation to be one transaction per
    // migration file under `supabase migration up`) rolls back.
    writeFileSync(
      scratchPath,
      `CREATE TABLE "stage5_retry_proof_scratch" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "created_at" timestamptz NOT NULL DEFAULT now());--> statement-breakpoint\nSELECT 1/0;\n`,
    );

    const failureRun = supabaseMigrationUp("failure-run", dbUrl, workdirFailure);
    assert(failureRun.exitCode !== 0, "Phase 3: the deliberately-failing migration was expected to fail but exited 0");
    const scratchTableExistsAfterFailure = await sql`SELECT to_regclass('public.stage5_retry_proof_scratch') AS reg`;
    assert(scratchTableExistsAfterFailure[0].reg === null, "Phase 3: the failed migration's own CREATE TABLE persisted despite the failure — transaction was not rolled back");
    const stateAfterFailure = await schemaMigrationsState(sql);
    assert(stateAfterFailure.length === prefixFiles.length, `Phase 3: expected only the ${prefixFiles.length} pre-existing migrations tracked after a failed run, got ${stateAfterFailure.length}`);
    assert(!stateAfterFailure.some((r) => r.version === "99999999999999"), "Phase 3: the failed migration was incorrectly marked as applied");

    // Remove the failure condition (same filename, corrected content) and retry.
    writeFileSync(
      scratchPath,
      `CREATE TABLE "stage5_retry_proof_scratch" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "created_at" timestamptz NOT NULL DEFAULT now());\n`,
    );
    const retryRun = supabaseMigrationUp("retry-run", dbUrl, workdirFailure);
    assert(retryRun.exitCode === 0, `Phase 3: retry run (failure condition removed) failed: ${retryRun.stderr || retryRun.stdout}`);
    const scratchTableExistsAfterRetry = await sql`SELECT to_regclass('public.stage5_retry_proof_scratch') AS reg`;
    assert(scratchTableExistsAfterRetry[0].reg !== null, "Phase 3: corrected migration ran but its table does not exist");
    const stateAfterRetry = await schemaMigrationsState(sql);
    assert(stateAfterRetry.length === prefixFiles.length + 1, `Phase 3: expected ${prefixFiles.length + 1} tracked after retry, got ${stateAfterRetry.length}`);
    assert(stateAfterRetry.some((r) => r.version === "99999999999999"), "Phase 3: corrected migration was not marked applied after retry");

    const laterRerun = supabaseMigrationUp("retry-rerun-idempotent", dbUrl, workdirFailure);
    assert(laterRerun.exitCode === 0, `Phase 3: later rerun failed: ${laterRerun.stderr || laterRerun.stdout}`);
    assert(JSON.parse(laterRerun.stdout).applied.length === 0, `Phase 3: later rerun should apply zero, got ${laterRerun.stdout}`);
    const stateAfterLaterRerun = await schemaMigrationsState(sql);
    assert(stateAfterLaterRerun.length === stateAfterRetry.length, "Phase 3: tracked count changed on final idempotent rerun");

    // Clean up the scratch table itself (belongs to a disposable, about-to-be-destroyed
    // container/database anyway, but tidy regardless).
    await sql.unsafe(`DROP TABLE IF EXISTS stage5_retry_proof_scratch`);
    await sql.end({ timeout: 1 });
    results.failureRetry = { failureRun: failureRun.exitCode, retryRun: retryRun.exitCode, laterRerun: laterRerun.exitCode };
    log("PHASE 3 (failure/retry semantics): PASS — failed migration's DDL did not persist and was not marked applied; retry applied it exactly once; further rerun applied zero.");
  }

  saveManualSidecar("stage5-migration-runner-proof-summary", { results, allPhasesPassed: true });
  console.log("[stage5-runner-proof] MIGRATION RUNNER PROOF: PASS (DB-09, pending-only, failure/retry all verified against the authoritative supabase CLI runner)");
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    saveManualSidecar("stage5-migration-runner-proof-summary", { error: error instanceof Error ? error.message : String(error), allPhasesPassed: false });
  })
  .finally(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
    if (containerName) {
      log(`stopping and removing container "${containerName}"`);
      spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
    }
  });
