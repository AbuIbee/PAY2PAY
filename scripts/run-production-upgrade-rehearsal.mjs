#!/usr/bin/env node
/**
 * "PAID2YOU — FINAL TWO P0 CLOSURE ITEMS" (2026-10-03+), Item F: the ONE independently runnable
 * artifact proving a true representative pre-upgrade database rehearsal — never the "empty database +
 * full migration chain" proof `npm run test:postgres`/`npm run db:fresh-migration-test` already give,
 * which does NOT satisfy this requirement (nothing pre-upgrade is ever inserted there).
 *
 * Reuses this repository's own disposable-Postgres container-lifecycle safety utilities
 * (scripts/postgres-test-db.mjs) and migration-bootstrap stubs (scripts/apply-migrations-fresh.mjs) —
 * never a second, competing Docker-safety implementation.
 *
 * SEQUENCE:
 *   1. Start a disposable, uniquely-named Postgres container (random host port, loopback-only).
 *   2. Apply migration files 0..CUT_POINT (inclusive) only — the exact pre-upgrade schema a real,
 *      existing Paid2You Business database had immediately before the Final RBAC / commercial-catalog
 *      / provider-webhook completion sequence (see CUT_POINT_FILE's own const for the chosen file and
 *      why).
 *   3. Seed a representative record set against THAT historical schema (scripts/productionUpgradeRehearsal.ts
 *      --phase=seed) — including a membership/invitation with a genuinely null role_id, only
 *      constructible at this exact point in the chain (see that script's own doc comment).
 *   4. Attempt to apply the very next migration (20261003040000_final_rbac_role_id_constraints.sql)
 *      BEFORE running the backfill — this MUST fail (the CHECK constraint rejects the still-null
 *      role_id row), proving the backfill is genuinely required, not decorative.
 *   5. Run the real production backfill (`npm run db:backfill-legacy-roles`'s own script) TWICE in a
 *      row — the second run proves idempotency (zero additional rows backfilled).
 *   6. Apply every remaining migration file in normal order — the role_id-constraint migration now
 *      succeeds for real.
 *   7. Verify preservation + final-schema invariants (scripts/productionUpgradeRehearsal.ts --phase=verify).
 *   8. Tear down the container unconditionally.
 *
 * Run with: `npm run db:upgrade-rehearsal` (see package.json), or directly:
 *   node scripts/run-production-upgrade-rehearsal.mjs
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

/**
 * "WHY THIS IS THE SMALLEST VALID REPRESENTATIVE CUT POINT" (per the owner's own Item F
 * instruction): the migration immediately BEFORE the Final RBAC / commercial-catalog / provider-
 * webhook completion sequence (20261003040000/20261003050000/20261003060000). At this exact point:
 *   - business_staff_member.role_id / business_staff_invitation.role_id already exist (added by
 *     20261002010000) but carry NO check constraint yet — the one and only point in the whole chain
 *     where a genuinely historical null-role_id row is constructible via an ordinary insert.
 *   - organization_role/organization_role_permission, business_customer/business_obligation,
 *     legal_acceptance, subscription_usage/subscription_invoice/subscription_payment_method, and
 *     agreement.organization_id already exist (added by 20261002000000/20261002010000) — every
 *     required representative entity in Item F's own list is already constructible.
 *   - pricing_plan has NO canonical Business catalog rows yet (that INSERT is 20261003050000) — so a
 *     pre-seeded 'paid2you_business_core' row genuinely represents "an organization already on a plan
 *     before the production-catalog migration formalized the full catalog," exactly the scenario that
 *     migration's own ON CONFLICT DO NOTHING is designed for.
 *   - business_verification_webhook_event/platform_billing_webhook_event do not exist yet (added by
 *     20261003060000) — these are genuinely NEW tables with no historical analog, so this rehearsal
 *     only ever verifies their post-migration structure/uniqueness, never pretends they have
 *     historical data.
 * Choosing anything later would skip exercising the role_id-constraint/backfill sequence entirely
 * (the single riskiest migration in the whole remaining chain). Choosing anything earlier would not
 * change which representative entities are constructible (every one of them already exists by
 * 20261002010000) while needlessly re-deriving an older historical schema this repository's own
 * migration history does not need — in violation of the owner's own "do not arbitrarily choose an
 * ancient migration" instruction.
 */
const CUT_POINT_FILE = "20261002030000_business_onboarding_fields.sql";
const FIRST_POST_CUT_POINT_FILE = "20261003040000_final_rbac_role_id_constraints.sql";

function log(message) {
  console.log(`[upgrade-rehearsal] ${message}`);
}

function fail(message) {
  console.error(`[upgrade-rehearsal] FAIL: ${message}`);
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
    console.error(`[upgrade-rehearsal] failed to launch "${cmd}": ${result.error.message}`);
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
  // Identical to apply-migrations-fresh.mjs's own bootstrap — the only Supabase-specific behavior
  // this repository's migrations reference (anon/authenticated roles, storage.buckets), never a
  // second, drifting copy of real Supabase-managed schema.
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

async function applyMigrationRange(sql, files, label) {
  for (const file of files) {
    log(`applying ${label} migration: ${file}`);
    await sql.file(path.join(migrationsDir, file));
  }
}

function tsxEnv(databaseUrl) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "test",
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

  const files = allMigrationFiles();
  const cutIndex = files.indexOf(CUT_POINT_FILE);
  const nextIndex = files.indexOf(FIRST_POST_CUT_POINT_FILE);
  if (cutIndex === -1) throw new HarnessFailure(`cut-point migration "${CUT_POINT_FILE}" not found in ${migrationsDir}`);
  if (nextIndex !== cutIndex + 1) throw new HarnessFailure(`expected "${FIRST_POST_CUT_POINT_FILE}" to immediately follow the cut point — migration chain order may have changed; update CUT_POINT_FILE/FIRST_POST_CUT_POINT_FILE`);

  const preCutFiles = files.slice(0, cutIndex + 1);
  const remainingFiles = files.slice(cutIndex + 1);

  const containerName = generateContainerName();
  const runToken = randomUUID();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "upgrade-rehearsal-"));
  const sentinelFile = path.join(tmpDir, "sentinels.json");

  let finished = false;
  const cleanupAndFinalize = () => {
    if (finished) return;
    finished = true;
    log(`stopping and removing this run's own container "${containerName}" (if it exists)`);
    const { exitCode, removalOk, removalError } = finalizeHarnessRun({ containerName, primaryExitCode: process.exitCode ?? 0 });
    if (!removalOk) console.error(`[upgrade-rehearsal] failed to remove this run's own container "${containerName}": ${removalError}`);
    process.exitCode = exitCode;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup only — never affects the primary exit code.
    }
  };
  const onSignal = (signal) => {
    console.error(`[upgrade-rehearsal] received ${signal} — cleaning up before exit`);
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

    log(`--- STEP 1/7: applying migrations THROUGH the pre-upgrade cut point (${preCutFiles.length} files, through "${CUT_POINT_FILE}") ---`);
    await applyMigrationRange(sql, preCutFiles, "pre-cut-point");

    log("--- STEP 2/7: seeding representative pre-upgrade data (scripts/productionUpgradeRehearsal.ts --phase=seed) ---");
    const seedCode = run("npx", ["tsx", "--conditions=react-server", "scripts/productionUpgradeRehearsal.ts", "--phase=seed", `--out=${sentinelFile}`], { cwd: repoRoot, env: tsxEnv(databaseUrl) });
    if (seedCode !== 0) throw new HarnessFailure("seed phase failed", seedCode);

    log(`--- STEP 3/7: proving the backfill is genuinely required — attempting "${FIRST_POST_CUT_POINT_FILE}" BEFORE any backfill (this MUST fail) ---`);
    let earlyApplyFailed = false;
    let earlyApplyError = "";
    try {
      await sql.file(path.join(migrationsDir, FIRST_POST_CUT_POINT_FILE));
    } catch (error) {
      earlyApplyFailed = true;
      earlyApplyError = error instanceof Error ? error.message : String(error);
    }
    if (!earlyApplyFailed) {
      throw new HarnessFailure(`EXPECTED "${FIRST_POST_CUT_POINT_FILE}" to fail against the still-null role_id seed data, but it succeeded — the seed data does not actually represent the pre-cutover condition this rehearsal is supposed to prove. Rehearsal is INVALID.`);
    }
    log(`CONFIRMED: "${FIRST_POST_CUT_POINT_FILE}" fails without the backfill (${earlyApplyError.split("\n")[0]}) — the backfill step below is genuinely required, not decorative.`);

    log("--- STEP 4/7: running the REAL production backfill (npm run db:backfill-legacy-roles) — FIRST run ---");
    const backfill1 = runCapture("npx", ["tsx", "--conditions=react-server", "scripts/backfill-legacy-organization-roles.ts"], { cwd: repoRoot, env: tsxEnv(databaseUrl) });
    console.log(backfill1.stdout);
    console.error(backfill1.stderr);
    if (!backfill1.ok) throw new HarnessFailure("first backfill run failed");
    if (!/memberships backfilled: [1-9]/.test(backfill1.stdout)) {
      throw new HarnessFailure(`first backfill run reported zero memberships backfilled — the seed data's null role_id rows were not actually discovered. Output: ${backfill1.stdout}`);
    }

    log("--- STEP 4/7 (continued): running the SAME backfill a SECOND time — proving idempotency ---");
    const backfill2 = runCapture("npx", ["tsx", "--conditions=react-server", "scripts/backfill-legacy-organization-roles.ts"], { cwd: repoRoot, env: tsxEnv(databaseUrl) });
    console.log(backfill2.stdout);
    console.error(backfill2.stderr);
    if (!backfill2.ok) throw new HarnessFailure("second (idempotency-proving) backfill run failed");
    if (!/memberships backfilled: 0, invitations backfilled: 0/.test(backfill2.stdout)) {
      throw new HarnessFailure(`second backfill run did not report zero additional rows backfilled — NOT idempotent. Output: ${backfill2.stdout}`);
    }
    log("CONFIRMED: second backfill run backfilled zero additional rows — idempotent.");

    log(`--- STEP 5/7: applying every remaining migration in normal order (${remainingFiles.length} files, starting with "${FIRST_POST_CUT_POINT_FILE}") ---`);
    await applyMigrationRange(sql, remainingFiles, "remaining");
    log(`CONFIRMED: "${FIRST_POST_CUT_POINT_FILE}" now applies cleanly, for real, now that the backfill has run.`);

    log("--- STEP 6/7: verifying preservation + final-schema invariants (scripts/productionUpgradeRehearsal.ts --phase=verify) ---");
    const verifyCode = run("npx", ["tsx", "--conditions=react-server", "scripts/productionUpgradeRehearsal.ts", "--phase=verify", `--in=${sentinelFile}`], { cwd: repoRoot, env: tsxEnv(databaseUrl) });
    if (verifyCode !== 0) throw new HarnessFailure("verify phase failed", verifyCode);

    log("--- STEP 7/7: PASS — representative pre-upgrade migration rehearsal complete ---");
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof HarnessFailure) {
      fail(error.message);
      process.exitCode = error.exitCode || 1;
    } else {
      console.error("[upgrade-rehearsal] fatal error:", error);
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
