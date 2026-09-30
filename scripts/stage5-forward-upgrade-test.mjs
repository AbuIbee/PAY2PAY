#!/usr/bin/env node
/**
 * Stage 5 (Database and Migration Readiness) — Step 10: forward-upgrade test. Provisions a genuinely
 * disposable Postgres, applies every migration THROUGH the fixed cutoff (the migration immediately
 * preceding the first new Stage 5 migration — never a different cutoff), seeds one representative row
 * in the one table the new Stage 5 migration actually touches (`payment_attempt.status`, via the
 * `payment_attempt_status` enum), applies the remaining Stage 5 migration(s), then re-reads the seeded
 * row and proves its recorded persisted field values are unchanged (string-equality comparison of
 * six named fields, not a literal byte/serialization comparison of the whole row) — the new
 * migration is additive-only (new enum values), so nothing pre-existing may change.
 *
 * Mirrors apply-migrations-fresh.mjs's own bootstrap stub (anon/authenticated roles, storage.buckets)
 * and this repo's established disposable-container safety conventions (unique name, label, loopback-
 * only, forbidden-port rejection, unconditional cleanup) — never touches production/staging/shared.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const CUTOFF_FILE = "20260928000000_ledger_entry_type_stage4_parity.sql";
const IMAGE = "postgres:17-alpine";
const FORBIDDEN_PORTS = new Set(["54322", "5432"]);

function log(message) {
  console.log(`[stage5-forward-upgrade] ${message}`);
}

function fail(message) {
  console.error(`[stage5-forward-upgrade] ${message}`);
  process.exitCode = 1;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.error?.message || result.stdout}`);
  }
  return result.stdout;
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

async function applyMigrationsThrough(sql, files, cutoffInclusive) {
  const cutoffIndex = files.indexOf(cutoffInclusive);
  if (cutoffIndex === -1) throw new Error(`Cutoff file "${cutoffInclusive}" not found in ${migrationsDir}`);
  const toApply = files.slice(0, cutoffIndex + 1);
  for (const file of toApply) {
    await sql.file(path.join(migrationsDir, file));
  }
  return toApply.length;
}

async function applyMigrationsAfter(sql, files, cutoffInclusive) {
  const cutoffIndex = files.indexOf(cutoffInclusive);
  const toApply = files.slice(cutoffIndex + 1);
  for (const file of toApply) {
    await sql.file(path.join(migrationsDir, file));
  }
  return toApply;
}

let containerName;

async function main() {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  containerName = `pay2pay-stage5-upgrade-${process.pid}-${randomBytes(4).toString("hex")}`;
  const runToken = randomUUID();

  log(`starting disposable Postgres container "${containerName}"`);
  run("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    "pay2pay-test-harness=true",
    "--label",
    `pay2pay-stage5-upgrade-run=${runToken}`,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    IMAGE,
  ]);

  const portOutput = run("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(\d+)\s*$/m.exec(portOutput.trim().split("\n").pop() ?? "");
  const hostPort = match?.[1];
  if (!hostPort) throw new Error(`could not parse assigned port from: ${portOutput}`);
  if (FORBIDDEN_PORTS.has(hostPort)) throw new Error(`refusing forbidden port ${hostPort}`);
  const host = "127.0.0.1";
  log(`Postgres will be reachable at ${host}:${hostPort} (container "${containerName}")`);

  const databaseUrl = `postgres://postgres:postgres@${host}:${hostPort}/postgres`;

  // Wait for readiness.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const probe = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 2 });
      await probe`SELECT 1`;
      await probe.end({ timeout: 1 });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error("Postgres did not become ready in time");

  // Independent identity proof — never trust a bare name/localhost string alone.
  const inspectRaw = run("docker", ["inspect", containerName]);
  const inspection = JSON.parse(inspectRaw)[0];
  if (!inspection?.Id || inspection.Name.replace(/^\//, "") !== containerName || inspection.Config.Image !== IMAGE || !inspection.State.Running) {
    throw new Error("container identity verification failed — refusing to proceed");
  }
  log(`host-side identity confirmed (container id ${inspection.Id.slice(0, 12)}..., image ${inspection.Config.Image})`);
  const identitySql = postgres(databaseUrl, { max: 1, prepare: false });
  const [identityRow] = await identitySql`SELECT current_database() AS database, current_user AS "user"`;
  if (identityRow.database !== "postgres" || identityRow.user !== "postgres") {
    throw new Error("in-database identity verification failed — refusing to proceed");
  }
  log("in-database identity confirmed (current_database=postgres, current_user=postgres)");

  await bootstrapSupabaseStubs(identitySql);

  const cutoffIndex = files.indexOf(CUTOFF_FILE);
  if (cutoffIndex === -1) throw new Error(`Cutoff file "${CUTOFF_FILE}" not found`);
  const stage5Files = files.slice(cutoffIndex + 1);
  log(`cutoff: ${CUTOFF_FILE} (migration #${cutoffIndex + 1} of ${files.length}) — ${stage5Files.length} Stage 5 migration(s) to apply after seeding: ${stage5Files.join(", ")}`);

  const appliedThroughCutoff = await applyMigrationsThrough(identitySql, files, CUTOFF_FILE);
  log(`applied ${appliedThroughCutoff} migrations through cutoff.`);

  // Seed exactly one representative row in the table the new Stage 5 migration touches
  // (payment_attempt.status, via payment_attempt_status) — no FK parent rows required, since
  // payerProfileId/recipientProfileId are plain UUIDs (not FKs) and agreementId is nullable.
  const seedId = randomUUID();
  const seedIdempotencyKey = `stage5-forward-upgrade-${randomUUID()}`;
  await identitySql`
    INSERT INTO payment_attempt (id, idempotency_key, payer_profile_kind, payer_profile_id, recipient_profile_kind, recipient_profile_id, amount_minor_units, currency, status, provider_name)
    VALUES (${seedId}, ${seedIdempotencyKey}, 'personal', ${randomUUID()}, 'personal', ${randomUUID()}, 12345, 'USD', 'succeeded', 'sandbox_mock')
  `;
  const [seededBefore] = await identitySql`SELECT id, idempotency_key, status, amount_minor_units, currency, provider_name FROM payment_attempt WHERE id = ${seedId}`;
  if (!seededBefore) throw new Error("seed row not found immediately after insert");
  log(`seeded payment_attempt ${seedId} with status='succeeded', amount=12345.`);

  const appliedStage5 = await applyMigrationsAfter(identitySql, files, CUTOFF_FILE);
  log(`applied ${appliedStage5.length} Stage 5 migration(s): ${appliedStage5.join(", ")}`);

  const [seededAfter] = await identitySql`SELECT id, idempotency_key, status, amount_minor_units, currency, provider_name FROM payment_attempt WHERE id = ${seedId}`;
  if (!seededAfter) throw new Error("seed row disappeared after applying Stage 5 migrations");

  const fields = ["id", "idempotency_key", "status", "amount_minor_units", "currency", "provider_name"];
  const mismatches = fields.filter((f) => String(seededBefore[f]) !== String(seededAfter[f]));
  if (mismatches.length > 0) {
    throw new Error(`seeded row values changed after Stage 5 migrations: ${mismatches.map((f) => `${f}: ${seededBefore[f]} -> ${seededAfter[f]}`).join(", ")}`);
  }

  const rowCountRow = await identitySql`SELECT count(*)::int AS n FROM payment_attempt`;
  log(`payment_attempt row count after upgrade: ${rowCountRow[0].n} (>= 1 expected).`);

  await identitySql.end({ timeout: 1 });
  console.log(`[stage5-forward-upgrade] FORWARD UPGRADE: PASS (cutoff=${CUTOFF_FILE}, migrations_before=${appliedThroughCutoff}, migrations_after=${appliedStage5.length}, seed preserved)`);
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  })
  .finally(() => {
    if (containerName) {
      log(`stopping and removing container "${containerName}"`);
      spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
    }
  });
