#!/usr/bin/env node
/**
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION", P0-1 required test (Section 6): proves the SAME command
 * documented for production — `npm run db:upgrade-production`
 * (scripts/run-production-upgrade.mjs) — correctly sequences backfill-before-constraint against a
 * database that genuinely has pre-existing legacy role_id-NULL data, end to end, as ONE invocation —
 * never by this rehearsal script manually performing the ordering itself (that would only prove the
 * ordering CAN be done safely, not that the production command DOES it safely).
 *
 * Distinct from, and complementary to, scripts/run-production-upgrade-rehearsal.mjs (which proves the
 * underlying migration-chain/backfill MECHANICS — including that the barrier migration genuinely fails
 * without a backfill — and is unchanged by this item). This script instead proves the NEW orchestrator
 * SCRIPT ITSELF is the one safe path, including its own "detect position, never reapply an
 * already-applied migration" guarantee.
 *
 * SEQUENCE:
 *   1. Start a disposable Postgres container.
 *   2. Apply migrations through the pre-upgrade cut point directly, via the SAME tracking-table
 *      mechanism scripts/run-production-upgrade.mjs's own direct-sql test applier uses (so its
 *      tracking table is already warm — proving step 4 below does NOT redundantly re-apply these
 *      files, satisfying "detect current migration position; never reapply an already-applied
 *      migration").
 *   3. Seed representative pre-upgrade data WITH null role_id (reuses
 *      scripts/productionUpgradeRehearsal.ts --phase=seed directly — never a second, duplicated seed
 *      implementation).
 *   4. Run `npm run db:upgrade-production` (PRODUCTION_UPGRADE_APPLY_MODE=direct-sql) — ONE command,
 *      exactly as the runbook documents — and assert it exits 0.
 *   5. Verify preservation + final-schema invariants (reuses
 *      scripts/productionUpgradeRehearsal.ts --phase=verify directly).
 *   6. Tear down the container unconditionally.
 *
 * Run with: `npm run db:upgrade-orchestrator-rehearsal`
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const CUT_POINT_FILE = "20261002030000_business_onboarding_fields.sql";

function log(message) {
  console.log(`[upgrade-orchestrator-rehearsal] ${message}`);
}
function fail(message) {
  console.error(`[upgrade-orchestrator-rehearsal] FAIL: ${message}`);
}

class HarnessFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function run(cmd, args, opts = {}) {
  const onWindows = process.platform === "win32";
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: onWindows, ...opts });
  if (result.error) {
    console.error(`[upgrade-orchestrator-rehearsal] failed to launch "${cmd}": ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function runCapture(cmd, args, opts = {}) {
  const onWindows = process.platform === "win32";
  const result = spawnSync(cmd, args, { encoding: "utf8", shell: onWindows, ...opts });
  if (result.error) return { ok: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

/**
 * Applies the given migration files directly, recording each in the SAME tracking table
 * scripts/run-production-upgrade.mjs's own `applyViaDirectSql` uses — so when the orchestrator runs
 * afterward against this same database, it correctly recognizes these files as already applied and
 * does not attempt to reapply them (this is the actual behavior under test, not an assumption).
 */
async function preApplyWithSharedTracking(sql, files) {
  await sql`CREATE TABLE IF NOT EXISTS _production_upgrade_applied_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of files) {
    log(`pre-applying (warming the orchestrator's own tracking table): ${file}`);
    await sql.file(path.join(migrationsDir, file));
    await sql`INSERT INTO _production_upgrade_applied_migrations (filename) VALUES (${file})`;
  }
}

function allMigrationFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function tsxEnv(databaseUrl, extra = {}) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "test",
    ...extra,
  };
}

async function main() {
  const requestedPort = process.env.POSTGRES_TEST_PORT;
  const portCheck = validateRequestedPort(requestedPort);
  if (!portCheck.ok) {
    fail(portCheck.reason);
    process.exitCode = 1;
    return;
  }

  const containerName = generateContainerName();
  const runToken = randomUUID();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "upgrade-orchestrator-rehearsal-"));
  const sentinelFile = path.join(tmpDir, "sentinels.json");

  let finished = false;
  const cleanupAndFinalize = () => {
    if (finished) return;
    finished = true;
    log(`stopping and removing this run's own container "${containerName}" (if it exists)`);
    const { exitCode, removalOk, removalError } = finalizeHarnessRun({ containerName, primaryExitCode: process.exitCode ?? 0 });
    if (!removalOk) console.error(`[upgrade-orchestrator-rehearsal] failed to remove this run's own container "${containerName}": ${removalError}`);
    process.exitCode = exitCode;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort only.
    }
  };
  const onSignal = (signal) => {
    console.error(`[upgrade-orchestrator-rehearsal] received ${signal} — cleaning up before exit`);
    process.exitCode = 130;
    cleanupAndFinalize();
    process.exit(process.exitCode);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let sql;
  try {
    log(`starting disposable Postgres container "${containerName}" (image ${IMAGE}, run token ${runToken})`);
    const startResult = runCapture("docker", buildDockerRunArgs({ containerName, runToken, image: IMAGE, hostPort: requestedPort }));
    if (!startResult.ok) {
      console.error(startResult.stderr || startResult.error?.message || "docker run failed");
      throw new HarnessFailure("failed to start the disposable Postgres container — is Docker running?", 1);
    }

    let hostPort = requestedPort;
    if (!hostPort) {
      const portResult = runCapture("docker", ["port", containerName, "5432/tcp"]);
      if (!portResult.ok) throw new HarnessFailure("failed to discover the Docker-assigned host port", 1);
      hostPort = parseDockerPortOutput(portResult.stdout);
      if (!hostPort) throw new HarnessFailure(`could not parse assigned port from: ${portResult.stdout}`, 1);
    }
    const targetCheck = validateResolvedTarget("127.0.0.1", hostPort);
    if (!targetCheck.ok) throw new HarnessFailure(`refusing to connect to a resolved database target that failed safety validation: ${targetCheck.reason}`, 1);

    const databaseUrl = buildDatabaseUrl(hostPort);
    log(`Postgres will be reachable at 127.0.0.1:${hostPort} (container "${containerName}")`);
    log("waiting for Postgres to accept connections...");
    await waitForReady(databaseUrl);

    sql = postgres(databaseUrl, { max: 1 });
    await bootstrapSupabaseStubs(sql);

    const allFiles = allMigrationFiles();
    const cutIndex = allFiles.indexOf(CUT_POINT_FILE);
    if (cutIndex === -1) throw new HarnessFailure(`cut-point migration "${CUT_POINT_FILE}" not found`);
    const preCutFiles = allFiles.slice(0, cutIndex + 1);

    log(`--- STEP 1/4: pre-applying ${preCutFiles.length} migration(s) through the cut point (warms the orchestrator's own tracking table) ---`);
    await preApplyWithSharedTracking(sql, preCutFiles);

    log("--- STEP 2/4: seeding representative pre-upgrade data WITH null role_id (scripts/productionUpgradeRehearsal.ts --phase=seed) ---");
    const seedCode = run("npx", ["tsx", "--conditions=react-server", "scripts/productionUpgradeRehearsal.ts", "--phase=seed", `--out=${sentinelFile}`], { cwd: repoRoot, env: tsxEnv(databaseUrl) });
    if (seedCode !== 0) throw new HarnessFailure("seed phase failed");

    log('--- STEP 3/4: running the REAL production upgrade command — `npm run db:upgrade-production` (direct-sql test mode) — as ONE invocation ---');
    const upgradeCode = run("npx", ["node", "scripts/run-production-upgrade.mjs"], {
      cwd: repoRoot,
      env: tsxEnv(databaseUrl, { PRODUCTION_UPGRADE_APPLY_MODE: "direct-sql" }),
    });
    if (upgradeCode !== 0) throw new HarnessFailure("scripts/run-production-upgrade.mjs exited nonzero — the production upgrade command itself failed.");
    log("CONFIRMED: the production upgrade command completed successfully as a single invocation against a database with genuine pre-existing legacy role_id-NULL data.");

    log("--- STEP 4/4: verifying preservation + final-schema invariants (scripts/productionUpgradeRehearsal.ts --phase=verify) ---");
    const verifyCode = run("npx", ["tsx", "--conditions=react-server", "scripts/productionUpgradeRehearsal.ts", "--phase=verify", `--in=${sentinelFile}`], { cwd: repoRoot, env: tsxEnv(databaseUrl) });
    if (verifyCode !== 0) throw new HarnessFailure("verify phase failed");

    log("--- PASS — the documented production upgrade command safely sequences backfill before the role_id constraint, end to end. ---");
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof HarnessFailure) {
      fail(error.message);
      process.exitCode = error.exitCode || 1;
    } else {
      console.error("[upgrade-orchestrator-rehearsal] fatal error:", error);
      process.exitCode = 1;
    }
  } finally {
    if (sql) await sql.end({ timeout: 1 }).catch(() => {});
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanupAndFinalize();
  }
}

main();
