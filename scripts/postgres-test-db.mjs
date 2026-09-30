#!/usr/bin/env node
/**
 * R07 (DB integrity & concurrency hardening) — corrective pass. The disposable-PostgreSQL harness
 * `npm run test:postgres` runs. R03/R04/R05's fixes are all transaction/locking behavior that an
 * in-memory fake cannot meaningfully prove — this provisions a real, throwaway, UNIQUELY-NAMED
 * Postgres container, applies this repo's actual migrations to it (reusing
 * apply-migrations-fresh.mjs's exact bootstrap, unchanged), writes a run-scoped ownership marker
 * into it, runs only the `*.postgres.test.ts` suites against it, and always tears the container down
 * afterward — success, failure, or interruption.
 *
 * SAFETY (corrective pass — see the R03/R04/R05/R07 corrective-pass report for the full Codex
 * findings this addresses):
 *   - The container name is unique per run (pid + random suffix), generated once and used for every
 *     start/stop/cleanup call in this process — this script can never touch another run's container,
 *     concurrent or stale.
 *   - The host port defaults to a Docker-assigned random ephemeral port (never a fixed guess that
 *     could collide with another process or another concurrent test run). `POSTGRES_TEST_PORT`, if
 *     explicitly set, is validated BEFORE any `docker run` — port 54322 (this repo's own
 *     long-running local Supabase Postgres) and 5432 (the common system-default Postgres port) are
 *     explicitly rejected.
 *   - A random run token is generated, written into the disposable database itself (a marker table,
 *     after migrations apply) AND handed to the Vitest child process as `POSTGRES_TEST_RUN_TOKEN`.
 *     `vitest.postgres.setup.ts` queries the database for that exact token before running any test —
 *     proving the database it's about to run destructive tests against was actually provisioned by
 *     THIS invocation, not merely "some localhost Postgres that happens to be listening" (which
 *     localhost-only validation could never distinguish from, say, a developer's own local Supabase
 *     instance on a nonstandard port).
 *   - Every exit path (migration failure, test failure, startup failure, an uncaught exception, or a
 *     SIGINT/SIGTERM while a container is up) sets `process.exitCode` explicitly and removes exactly
 *     this run's own container in a `finally`/signal handler — never silently falls through to the
 *     default exit code 0.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { verifyHarnessOwnership } from "../test/postgres/verifyHarnessOwnership.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(__dirname, "..");

export const IMAGE = "postgres:17-alpine";
export const LABEL_KEY = "pay2pay-test-harness";

/** Ports this harness must never bind to, regardless of what POSTGRES_TEST_PORT requests. */
export const FORBIDDEN_PORTS = new Set([
  "54322", // this repo's own long-running local Supabase Postgres (docker container supabase_db_*)
  "5432", // the conventional system-default Postgres port — likely to collide with a developer's own local Postgres
]);

/**
 * FINAL corrective pass (Codex: `validateRequestedPort("054322")` passed even though it numerically
 * means port 54322 — the old order compared the RAW string against `FORBIDDEN_PORTS` first, so any
 * non-canonical spelling of a forbidden port (a leading zero, for example) skipped that check
 * entirely and then sailed through the separate numeric-range check, which only cared whether the
 * number was *a* valid port, not *which* one). Fixed order: parse/normalize to a number FIRST, reject
 * anything that isn't a valid TCP port, THEN re-stringify that number canonically (`String(54322)` is
 * always `"54322"`, never `"054322"`) and compare THAT against `FORBIDDEN_PORTS` — a numeric
 * comparison in substance, expressed via canonical-string membership so `FORBIDDEN_PORTS` stays a
 * plain, easily-read set of exact port strings.
 */
export function validateRequestedPort(port) {
  if (port === undefined || port === null || port === "") return { ok: true };
  const asNumber = Number(port);
  if (!Number.isInteger(asNumber) || asNumber < 1 || asNumber > 65535) {
    return { ok: false, reason: `POSTGRES_TEST_PORT=${port} is not a valid TCP port number.` };
  }
  const canonicalPort = String(asNumber);
  if (FORBIDDEN_PORTS.has(canonicalPort)) {
    return { ok: false, reason: `POSTGRES_TEST_PORT=${port} is a known shared/production-adjacent port and is rejected. Omit it to let Docker assign a random ephemeral port instead.` };
  }
  return { ok: true };
}

/** Loopback hosts this harness's resolved database target must always be — matches `buildDatabaseUrl`'s own hardcoded host, checked explicitly here too as defense-in-depth. */
export const APPROVED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * FINAL corrective pass, round 2 (Codex: "Docker-discovered mapped ports are not validated against
 * forbidden ports before DB connection"). Called after Docker reports the host/port this container is
 * actually reachable on (whether that came from an explicit, already-validated `POSTGRES_TEST_PORT`,
 * or — the default, preferred path — a random port Docker itself assigned) and BEFORE the harness
 * makes its first real database connection (`waitForReady`) or hands the target to
 * migrations/Vitest. Reuses `validateRequestedPort`'s exact numeric-port logic (same canonical
 * forbidden-port comparison, immune to the same leading-zero bypass that was fixed there), plus an
 * explicit loopback-host check. If this ever fails, the caller must stop before any DB connection —
 * `main`'s existing `finally`/cleanup path still runs, so this run's container is still removed.
 */
export function validateResolvedTarget(host, port) {
  if (!APPROVED_LOOPBACK_HOSTS.has(host)) {
    return { ok: false, reason: `resolved host "${host}" is not an approved loopback address — refusing to connect.` };
  }
  const portCheck = validateRequestedPort(port);
  if (!portCheck.ok) {
    return { ok: false, reason: `resolved port is unsafe: ${portCheck.reason}` };
  }
  return { ok: true };
}

export function generateContainerName() {
  return `pay2pay-pgtest-${process.pid}-${randomBytes(4).toString("hex")}`;
}

export function buildDockerRunArgs({ containerName, runToken, image, hostPort }) {
  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${LABEL_KEY}=true`,
    "--label",
    `${LABEL_KEY}-run=${runToken}`,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=postgres",
  ];
  // No explicit host port -> Docker assigns a random free ephemeral port (preferred). An explicit,
  // already-validated POSTGRES_TEST_PORT is honored as an opt-in override.
  args.push("-p", hostPort ? `127.0.0.1:${hostPort}:5432` : "127.0.0.1::5432");
  args.push(image);
  return args;
}

export function buildDatabaseUrl(hostPort) {
  return `postgres://postgres:postgres@127.0.0.1:${hostPort}/postgres`;
}

/** Parses `docker port <container> 5432/tcp` output (e.g. "0.0.0.0:32768\n127.0.0.1:32768") into the bound host port. */
export function parseDockerPortOutput(output) {
  const match = /:(\d+)\s*$/m.exec(output.trim().split("\n").pop() ?? "");
  return match ? match[1] : null;
}

function log(message) {
  console.log(`[test:postgres] ${message}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.error) {
    console.error(`[test:postgres] failed to launch "${cmd}": ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

/**
 * FINAL corrective pass (Codex, Docker startup/cleanup failure handling):
 *   - Cleanup ownership used to be gated on `docker run` itself having reported success
 *     (`containerStarted = true` only set after that check) — but `docker run -d --name X` can
 *     CREATE a container (claiming that unique name on the daemon) and then fail during the actual
 *     start, returning a nonzero exit code. That left a real, named container behind with nothing
 *     ever attempting to remove it, because `containerStarted` was still `false`.
 *   - `docker rm -f`'s own exit code used to be ignored outright (`stdio: "ignore"`, return value
 *     discarded) — so a genuine removal failure (not "there was never a container to remove", which
 *     is a harmless no-op, but an actual failure to remove one that exists) could leave a container
 *     running while the harness still reported success.
 *
 * Fix: cleanup is no longer gated on any earlier step's success — `finalizeHarnessRun` (below) always
 * attempts to remove EXACTLY the one container name this run generated, unconditionally, on every
 * exit path (`main`'s `finally`, and both signal handlers) — since that name is unique to this run
 * (see `generateContainerName`), this can never remove another run's container, satisfied or not.
 * `classifyRemovalResult` distinguishes "nothing to remove" (fine) from a genuine removal failure
 * (not fine — must make the harness exit nonzero even if every test otherwise passed).
 *
 * FINAL corrective pass, round 2 (Codex: this previously treated EVERY `spawnFn` error — EAGAIN,
 * ENOENT, EPERM, a crashed `docker` process, any failure to even launch or complete the command — as
 * equivalent to "no such container, nothing to clean up". That is wrong: those errors are proof of
 * NOTHING about whether a container exists — `docker` never even got to answer. Only Docker's own
 * successfully-received RESPONSE of "No such container" is genuine proof there is nothing to remove;
 * every other failure mode (a spawn-level error, or any other nonzero exit) must be treated as a
 * cleanup failure so the harness cannot silently report success while a container may have leaked.
 */
function classifyRemovalResult(result) {
  if (!result) return { ok: false, stderr: "docker rm produced no result" };
  if (result.error) {
    // A spawn/process-level error (ENOENT: docker binary missing, EAGAIN: resource temporarily
    // unavailable, EPERM, or any other failure to launch/complete the command) is NOT independent
    // proof that no container exists — it means we simply never got an answer from Docker at all.
    return { ok: false, stderr: `docker rm could not be run: ${result.error.message}` };
  }
  if (result.status === 0) return { ok: true };
  const stderr = String(result.stderr ?? "");
  // "No such container" is Docker's own successfully-received response that there was nothing to
  // clean up (docker run never actually created it, or an earlier attempt already removed it) — the
  // ONLY response classified as benign; every other nonzero result is a genuine cleanup failure.
  if (/No such container/i.test(stderr)) return { ok: true };
  return { ok: false, stderr };
}

/** Removes ONLY the container this exact run created — never touches any other container by name or label alone. `spawnFn` is injectable so tooling tests can exercise this without a real Docker daemon. */
export function removeThisRunContainer(containerName, spawnFn = spawnSync) {
  if (!containerName) return { ok: true };
  const result = spawnFn("docker", ["rm", "-f", containerName], { encoding: "utf8" });
  return classifyRemovalResult(result);
}

/**
 * Folds a cleanup outcome into the harness's final exit code (Codex: "if cleanup of this run's
 * container fails after tests otherwise pass, the harness must exit nonzero"). A nonzero
 * `primaryExitCode` (migration/test/startup failure) is never overwritten — it already correctly
 * signals failure regardless of what cleanup does.
 */
export function computeFinalExitCode(primaryExitCode, cleanupOk) {
  if (cleanupOk) return primaryExitCode;
  return primaryExitCode === 0 ? 1 : primaryExitCode;
}

/** Attempts this run's own container removal and returns the exit code the harness should actually report. Exported so tooling tests can drive it with a fake `spawnFn` (no real Docker required). */
export function finalizeHarnessRun({ containerName, primaryExitCode, spawnFn = spawnSync }) {
  const removal = removeThisRunContainer(containerName, spawnFn);
  return { exitCode: computeFinalExitCode(primaryExitCode, removal.ok), removalOk: removal.ok, removalError: removal.stderr };
}

/**
 * STAGE 2 CRITICAL REMEDIATION — FIX 01 (pre-migration isolation). Root-cause finding, established by
 * reading this file's own PREVIOUS `main()` in full: the original ordering was
 * `docker run` -> discover port -> `validateResolvedTarget` (a purely STATIC host/port string check,
 * no Docker metadata correlation at all) -> `waitForReady` (the FIRST real network connection) ->
 * `apply-migrations-fresh.mjs` (the FIRST schema write) -> `writeOwnershipMarker` (created only AFTER
 * migrations had already run) -> hand off to Vitest, whose OWN setup file is the only place
 * `verifyHarnessOwnership` (the marker CHECK) was ever called. In other words: migrations ran before
 * any ownership marker existed to check against, and the only real identity evidence available before
 * migrations was a static string comparison of the DISCOVERED host/port — never independent Docker
 * metadata (container ID/labels/image/running state) and never an in-database identity query
 * (`current_database()`/`current_user`) proving the connection actually reached what was intended. A
 * marker written AFTER the fact cannot retroactively protect a migration that already ran — this is
 * the exact defect this fix corrects, not merely re-describes.
 *
 * The corrected order `main()` now follows: (A) static preflight — unchanged, already existed
 * (`validateRequestedPort`/`validateResolvedTarget`); (B) `verifyContainerIdentity`, using REAL Docker
 * metadata (`docker inspect`) correlated against this run's own generated name/label/run-token/image —
 * never a name or localhost string alone; (C) `verifyDatabaseIdentity`, an in-database
 * `current_database()`/`current_user`/`inet_server_addr()`/`inet_server_port()`/`version()` query,
 * run immediately after the first connection and BEFORE any schema/data write; (D) marker bootstrap
 * (`writeOwnershipMarker`) immediately followed by its own verification (`verifyHarnessOwnership`,
 * imported directly — the SAME function Vitest's setup file also calls, so this is not a second,
 * divergent implementation) — both now happen BEFORE migrations, not after; (E) migrations only after
 * A-D all pass. See `main()` below for the exact call sequence.
 */
export function parseDockerInspectOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || typeof record !== "object") return null;
  const labels = record.Config?.Labels ?? {};
  const ports = record.NetworkSettings?.Ports ?? {};
  const tcpBindings = ports["5432/tcp"];
  const firstBinding = Array.isArray(tcpBindings) ? tcpBindings[0] : undefined;
  return {
    id: typeof record.Id === "string" && record.Id.length > 0 ? record.Id : null,
    name: typeof record.Name === "string" ? record.Name.replace(/^\//, "") : null,
    running: record.State?.Running === true,
    image: record.Config?.Image ?? null,
    labels,
    hostPort: firstBinding?.HostPort ?? null,
  };
}

/**
 * Correlates an independent `docker inspect` record against exactly what THIS run expects — its own
 * generated container name, its own run token (as the harness label), the pinned image, and running
 * state. A matching NAME alone is never sufficient (a name is just a string this same process chose;
 * it proves nothing about what Docker actually created) — the immutable container ID being non-empty,
 * the harness labels, and the image are independent signals that must all agree.
 */
export function verifyContainerIdentity({ inspection, containerName, runToken, expectedImage }) {
  if (!inspection) {
    return { ok: false, reason: "docker inspect returned no parseable record for this run's container." };
  }
  if (!inspection.id) {
    return { ok: false, reason: "container record has no immutable ID — refusing to trust an unidentifiable container." };
  }
  if (inspection.name !== containerName) {
    return { ok: false, reason: `container name "${inspection.name}" does not match this run's generated name "${containerName}".` };
  }
  if (inspection.labels?.[LABEL_KEY] !== "true") {
    return { ok: false, reason: `container is missing the expected "${LABEL_KEY}=true" label.` };
  }
  if (inspection.labels?.[`${LABEL_KEY}-run`] !== runToken) {
    return { ok: false, reason: "container's run-token label does not match this run's own generated token." };
  }
  if (inspection.image !== expectedImage) {
    return { ok: false, reason: `container image "${inspection.image}" does not match the expected "${expectedImage}".` };
  }
  if (!inspection.running) {
    return { ok: false, reason: "container is not reported as running." };
  }
  return { ok: true };
}

/**
 * In-database identity proof, run immediately after the first real connection and strictly before any
 * schema/data write. `sql` is dependency-injected (a tagged-template function matching the `postgres`
 * package's own client shape) so this can be unit-tested with a fake response, never a real database.
 * Deliberately does NOT assert `inet_server_addr()`/`inet_server_port()` against the published
 * host/port — Docker's internal server-side view of its own bind address/port need not equal (and
 * commonly does not equal) the externally published host mapping; those two values are recorded as
 * supplementary evidence only, never as a pass/fail condition.
 */
export async function verifyDatabaseIdentity({ sql, expectedDatabase, expectedUser }) {
  const rows = await sql`SELECT current_database() AS database, current_user AS "user", inet_server_addr()::text AS server_addr, inet_server_port() AS server_port, version() AS version`;
  const row = rows[0];
  if (!row) {
    return { ok: false, reason: "identity query returned no row." };
  }
  if (row.database !== expectedDatabase) {
    return { ok: false, reason: `current_database() is "${row.database}", expected "${expectedDatabase}".` };
  }
  if (row.user !== expectedUser) {
    return { ok: false, reason: `current_user is "${row.user}", expected "${expectedUser}".` };
  }
  return { ok: true, serverAddr: row.server_addr, serverPort: row.server_port, version: row.version };
}

/**
 * STAGE 2 CRITICAL REMEDIATION — approval separation (FIX 01, "Approval separation"). Default is
 * `"validate-only"`: provision, verify identity (B/C), bootstrap-and-verify the marker (D), and apply
 * migrations (E) — then STOP without ever invoking the `*.postgres.test.ts` financial-recovery suite.
 * The suite only runs when this run was explicitly invoked with `--run-tests` on the command line —
 * `npm run test:postgres` (no arguments) can never reach it. This is a deliberate, minimal, explicit
 * gate: no printed warning followed by automatic execution:  the control-flow branch itself is
 * different, not merely a message.
 */
export function resolveRunMode(argv = process.argv) {
  return argv.includes("--run-tests") ? "run-tests" : "validate-only";
}

/**
 * STAGE 3 FINAL BLOCKER CLOSURE (docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md,
 * PostgreSQL-closure section): a single, fixed, opt-in selector — never a general-purpose filter
 * passthrough, never forwards arbitrary user-supplied CLI arguments, never introduces an alternate
 * database runner. Present only to let one explicitly authorized run execute exactly the two named
 * Stage 3 G03/G04 acceptance tests in `paymentWebhookRecovery.postgres.test.ts`
 * (`STAGE3-G03-REAL-FACTORY-POSTGRES-RECOVERY`/`STAGE3-G04-REAL-FACTORY-POSTGRES-RETRY-STATUS`),
 * instead of the full unfiltered `*.postgres.test.ts` collection `vitest.postgres.config.ts` otherwise
 * includes. `main()` requires `--run-tests` to also be present whenever this flag is present, checked
 * before any Docker command runs — this flag alone can never trigger test execution.
 */
export function resolveStage3G03G04Only(argv = process.argv) {
  return argv.includes("--stage3-g03-g04-only");
}

/**
 * STAGE 4 (financial-accounting remediation — settlement balance, payout atomicity, refund
 * correction, corrective-event accounting, reconciliation) — mirrors `resolveStage3G03G04Only`'s
 * exact fixed, single-purpose, opt-in shape: selects exactly this fixed list of new Stage 4
 * `*.postgres.test.ts` files, never an arbitrary filter, never a `-t` passthrough. Grown, file by
 * file, as each new Stage 4 postgres test file is authored — never removes or renames an entry once
 * added. Used for the one focused Stage 4 verification campaign (Section 12/13 of the Stage 4
 * closure order); the full, unfiltered `*.postgres.test.ts` collection is still what the one
 * broader regression pass (no selector at all) exercises.
 */
export const STAGE4_POSTGRES_TEST_FILES = [
  "src/lib/payouts/payoutAtomicity.postgres.test.ts",
  "src/lib/ledger/refundCorrection.postgres.test.ts",
  "src/lib/payments/correctiveEventAccounting.postgres.test.ts",
  "src/lib/ledger/reconciliationDrift.postgres.test.ts",
  // Directly affected by the WP-02 settlement-balance fix (BalanceService gained a new optional
  // dependency) — the one existing real-Postgres settlement suite, re-run here as the "directly
  // affected ledger regression" check for that change specifically.
  "src/lib/settlements/settlementBinding.postgres.test.ts",
  // Final remediation order: real-persisted settlement outcome cases (SETTLEMENT-READER-01..04).
  "src/lib/ledger/settlementBalanceReader.postgres.test.ts",
  // S4-03 remediation: appendAuditEventTxBound was refactored (shared helper extracted for the new
  // ensureAuditEventAtomicallyTxBound) — the existing R04 real-concurrency hash-chain suite directly
  // exercises the modified code path and is the regression guard for it.
  "src/lib/audit/auditService.postgres.test.ts",
];

export function resolveStage4Only(argv = process.argv) {
  return argv.includes("--stage4-only");
}

/**
 * STAGE 5 (Database and Migration Readiness) — mirrors `STAGE4_POSTGRES_TEST_FILES`'s exact fixed,
 * grown-file-by-file shape. Kept entirely separate from the Stage 4 selector so that selector is
 * never expanded (the Stage 5 closure order's own explicit instruction) — this is Stage 5's own,
 * independent fixed list.
 */
export const STAGE5_POSTGRES_TEST_FILES = ["src/db/schemaParity.postgres.test.ts", "src/db/indexExtraction.postgres.test.ts"];

export function resolveStage5Only(argv = process.argv) {
  return argv.includes("--stage5-only");
}

/**
 * STAGE 2 FINAL ROLE-OWNERSHIP CORRECTION — replaces the prior `REASSIGN OWNED BY postgres` design.
 *
 * That statement was withdrawn because it was never scoped to the application tables: `REASSIGN OWNED
 * BY <role>` reassigns ownership of EVERY object the source role owns in the current database — per
 * PostgreSQL's own documented behavior, this includes the `_pg_test_harness_marker` table (created by
 * `writeOwnershipMarker`, under the bootstrap role, before this statement would have run) and, when
 * executed as a superuser, can additionally reassign ownership of shared objects such as the database
 * itself if the bootstrap role owns it (the Docker Postgres image's default `postgres` database is
 * owned by the bootstrap `postgres` role at container creation). Neither of those was ever the intent —
 * the goal was only to let the runtime role do whatever the actual application tests need, never to
 * hand it the ownership-marker infrastructure or the database itself. **No live database confirmation
 * of this was possible or is claimed** (no connection is authorized under this order) — this is stated
 * on PostgreSQL's own documented `REASSIGN OWNED` semantics, not on an observed live result.
 *
 * Correction, grounded in an actual inspection performed before writing this replacement: every
 * `src/**\/*.postgres.test.ts` file (8 files) was grepped for `ALTER TABLE`, `DROP TABLE`,
 * `CREATE TABLE`, `CREATE INDEX`, `CREATE TEMP(ORARY)`, `TRUNCATE`, `DROP INDEX`, `ALTER/CREATE
 * SEQUENCE`, `CREATE/ALTER TYPE` — zero matches anywhere. The only raw SQL any test issues directly
 * (`paymentWebhookRecovery.postgres.test.ts`) is `SET statement_timeout = 50` (a session parameter,
 * not privilege-gated) and `SELECT pg_sleep(1)` (a built-in function, `EXECUTE` granted to `PUBLIC` by
 * default). **No existing test demonstrably requires DDL or object ownership at all** — the "real
 * DDL/DML" language in `vitest.postgres.setup.ts`'s own doc comment describes the disposable database
 * being capable of DDL (as the migration step, run separately under the bootstrap role, actually
 * performs), not the test bodies' own runtime operations, which are exclusively DML.
 *
 * The runtime role below is therefore DML-only — no ownership transfer of any kind, no `CREATE` on the
 * schema (nothing creates new objects), plain `GRANT`s scoped to the existing migrated tables/
 * sequences. `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` are unconditional. The one
 * explicitly flagged, narrowly-bounded exception — presented for owner approval, not silently decided —
 * is `BYPASSRLS`: every test in this suite has always run under the bootstrap role, which — being both
 * table owner and a superuser — was never actually subject to Row Level Security in the first place
 * (Postgres exempts a table's owner and any `BYPASSRLS` role from RLS by default). This schema's own
 * RLS policies (`.enableRLS()` on `payment_retry`/`notification_event`/etc.) were verified, in earlier
 * Stage 1 work, to pair with a `REVOKE ALL ... FROM anon, authenticated` pattern — i.e. this RLS model
 * is designed around a privileged service connection bypassing it entirely, with RLS only ever meant to
 * block a hypothetical direct low-privilege client, never the application's own backend queries. Making
 * the runtime role subject to RLS for the first time ever, with no live database available to verify
 * every policy actually permits every one of the 65+ existing tests' own queries, is exactly the kind
 * of untested, high-blast-radius change this fix must not silently introduce — so `BYPASSRLS` is
 * included specifically to preserve today's actual, already-proven test behavior, not to weaken
 * security (the runtime role's blast radius is still fully bounded by the disposable, loopback-only,
 * single-run container, and it can still never touch another role, another database, or replication).
 */
export const RUNTIME_ROLE_NAME = "pay2pay_test_runtime";
export const OWNERSHIP_MARKER_TABLE_NAME = "_pg_test_harness_marker";

export function buildRuntimeRoleStatements(password) {
  if (!password || typeof password !== "string" || password.length < 16) {
    throw new Error("buildRuntimeRoleStatements requires a randomly-generated password of at least 16 characters.");
  }
  return [
    `DROP ROLE IF EXISTS ${RUNTIME_ROLE_NAME}`,
    // BYPASSRLS: explicit, disclosed, owner-reviewable exception — see this function's own doc comment
    // above for exactly why (preserving proven existing test behavior, never object ownership, never
    // superuser, never database/role-creation rights, never replication).
    `CREATE ROLE ${RUNTIME_ROLE_NAME} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS`,
    `GRANT CONNECT ON DATABASE postgres TO ${RUNTIME_ROLE_NAME}`,
    `GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE_NAME}`,
    // DML only — never CREATE on the schema (nothing in the actual test suite creates a new object),
    // never an ownership transfer of any kind.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE_NAME}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE_NAME}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE_NAME}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME_ROLE_NAME}`,
    // The blanket table grant above also reaches the ownership-marker table (it is a table in the same
    // schema) — explicitly narrow it back down: the runtime role may only ever READ this table (the
    // exact query `verifyHarnessOwnership` issues), never write, truncate, or drop it, and it is never
    // made the marker table's owner (ownership is never transferred anywhere in this file).
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${OWNERSHIP_MARKER_TABLE_NAME} FROM ${RUNTIME_ROLE_NAME}`,
  ];
}

/** Builds the runtime role's own connection URL — never the bootstrap `postgres`/`postgres` URL — for handing to the actual `*.postgres.test.ts` Vitest run. Never logged in full; callers must redact the password the same way `verifyHarnessOwnership`'s own error path already does. */
export function buildRuntimeDatabaseUrl(hostPort, password) {
  return `postgres://${RUNTIME_ROLE_NAME}:${password}@127.0.0.1:${hostPort}/postgres`;
}

/**
 * STAGE 2 GATE B FINAL EVIDENCE COMPLETION — ORDER 02/03. The first Phase B run created the runtime
 * role and the harness-scratch/marker tables under the BOOTSTRAP connection, but never actually
 * connected AS the runtime role to confirm its effective identity/attributes/privileges, and never
 * performed any real write. This section closes both gaps, entirely offline (no execution occurs
 * merely by adding these functions — `main()` calls them only when actually run, and no run is
 * authorized under this order).
 */

/** A representative sample of real migrated application tables (not exhaustive — this is evidence, not a full audit) used to confirm the runtime role has the DML privileges the actual test suite depends on. */
export const APPLICATION_TABLES_TO_VERIFY = ["agreement", "payment_attempt", "payment_retry"];

/** Infrastructure-only scratch table, wholly separate from any application table — used solely for ORDER 03's harmless write-and-rollback demonstration. Never holds payment, provider, customer, bank, email, or SMS data of any kind, real or synthetic-but-shaped-like-production. */
export const SCRATCH_TABLE_NAME = "_pg_test_harness_scratch";

export function buildScratchTableStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS ${SCRATCH_TABLE_NAME} (id uuid primary key default gen_random_uuid(), note text not null, created_at timestamptz not null default now())`,
    `GRANT SELECT, INSERT ON ${SCRATCH_TABLE_NAME} TO ${RUNTIME_ROLE_NAME}`,
  ];
}

/** Connects AS the runtime role (never the bootstrap connection) and confirms `current_user` is actually the runtime role — the literal "not the bootstrap connection masquerading as the runtime role" proof this order requires. */
export async function verifyRuntimeRoleIdentity({ sql }) {
  const rows = await sql`SELECT current_user AS "user"`;
  const row = rows[0];
  if (!row || row.user !== RUNTIME_ROLE_NAME) {
    return { ok: false, reason: `connected as "${row?.user ?? "(no row)"}", expected "${RUNTIME_ROLE_NAME}".` };
  }
  return { ok: true };
}

/** Reads the runtime role's ACTUAL `pg_roles` attributes — not merely re-asserting the `CREATE ROLE` statement text, but confirming PostgreSQL itself recorded the intended attributes, including the one owner-accepted `BYPASSRLS` exception. */
export async function verifyRuntimeRoleAttributes({ sql }) {
  const rows = await sql`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ${RUNTIME_ROLE_NAME}`;
  const row = rows[0];
  if (!row) return { ok: false, reason: `no pg_roles row found for "${RUNTIME_ROLE_NAME}".` };
  if (row.rolsuper) return { ok: false, reason: "runtime role unexpectedly has SUPERUSER." };
  if (row.rolcreatedb) return { ok: false, reason: "runtime role unexpectedly has CREATEDB." };
  if (row.rolcreaterole) return { ok: false, reason: "runtime role unexpectedly has CREATEROLE." };
  if (row.rolreplication) return { ok: false, reason: "runtime role unexpectedly has REPLICATION." };
  if (!row.rolbypassrls) return { ok: false, reason: "runtime role is missing the explicitly owner-accepted BYPASSRLS exception." };
  return { ok: true };
}

/** Confirms, from PostgreSQL's own `has_table_privilege`/`pg_class` metadata (not merely re-reading the GRANT/REVOKE statement text this file itself issued), that the runtime role can read the ownership marker but cannot write, truncate, or own it. */
export async function verifyMarkerTableIsReadOnlyForRuntimeRole({ sql }) {
  const rows = await sql`
    SELECT
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${OWNERSHIP_MARKER_TABLE_NAME}, 'SELECT') AS can_select,
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${OWNERSHIP_MARKER_TABLE_NAME}, 'INSERT') AS can_insert,
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${OWNERSHIP_MARKER_TABLE_NAME}, 'UPDATE') AS can_update,
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${OWNERSHIP_MARKER_TABLE_NAME}, 'DELETE') AS can_delete,
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${OWNERSHIP_MARKER_TABLE_NAME}, 'TRUNCATE') AS can_truncate,
      (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = ${OWNERSHIP_MARKER_TABLE_NAME}) AS owner
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: "could not read marker-table privilege metadata." };
  if (!row.can_select) return { ok: false, reason: "runtime role cannot SELECT the marker table — verification would be impossible." };
  if (row.can_insert) return { ok: false, reason: "runtime role unexpectedly CAN INSERT into the marker table." };
  if (row.can_update) return { ok: false, reason: "runtime role unexpectedly CAN UPDATE the marker table." };
  if (row.can_delete) return { ok: false, reason: "runtime role unexpectedly CAN DELETE from the marker table." };
  if (row.can_truncate) return { ok: false, reason: "runtime role unexpectedly CAN TRUNCATE the marker table." };
  if (row.owner === RUNTIME_ROLE_NAME) return { ok: false, reason: "runtime role unexpectedly OWNS the marker table." };
  return { ok: true };
}

/** Confirms the runtime role actually has the DML privileges (never ownership, never DDL) the real test suite depends on for one representative application table. */
export async function verifyApplicationTablePrivileges({ sql, tableName }) {
  const rows = await sql`
    SELECT
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${tableName}, 'SELECT') AS can_select,
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${tableName}, 'INSERT') AS can_insert,
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${tableName}, 'UPDATE') AS can_update,
      has_table_privilege(${RUNTIME_ROLE_NAME}, ${tableName}, 'DELETE') AS can_delete
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: `could not read privilege metadata for "${tableName}".` };
  if (!row.can_select || !row.can_insert || !row.can_update || !row.can_delete) {
    return { ok: false, reason: `runtime role is missing a required DML privilege on "${tableName}" (select=${row.can_select}, insert=${row.can_insert}, update=${row.can_update}, delete=${row.can_delete}).` };
  }
  return { ok: true };
}

/**
 * ORDER 03: one harmless, real PostgreSQL write, performed AS the runtime role, against the
 * infrastructure-only scratch table — never an application table, never the ownership marker. Inserts
 * one synthetic row, observes it from inside the SAME transaction, unconditionally rolls back, then
 * re-queries AFTER rollback to confirm zero rows persisted. Returns `{ ok: false, reason }` for any
 * failure at any step — never throws, so the caller can apply the SAME fail-closed `HarnessFailure`
 * treatment as every other verification in this file.
 */
export async function performHarmlessScratchOperation({ sql }) {
  const testNote = `gate-b-harmless-check-${randomUUID()}`;
  try {
    try {
      await sql`BEGIN`;
      // `sql.unsafe(text, params)` — the table name is this file's own fixed, internally-controlled
      // constant (never user input), and the actual VALUE is still safely parameterized ($1), so this
      // is not a string-concatenation injection risk; it only avoids needing postgres.js's separate
      // dynamic-identifier helper for a name that never varies.
      const insertedRows = await sql.unsafe(`INSERT INTO ${SCRATCH_TABLE_NAME} (note) VALUES ($1) RETURNING id, note`, [testNote]);
      const inserted = insertedRows[0];
      if (!inserted || inserted.note !== testNote) {
        throw new Error("inserted row could not be read back correctly within the same transaction.");
      }
      const visibleRows = await sql.unsafe(`SELECT id FROM ${SCRATCH_TABLE_NAME} WHERE note = $1`, [testNote]);
      if (visibleRows.length !== 1) {
        throw new Error(`expected exactly 1 visible row inside the transaction, found ${visibleRows.length}.`);
      }
    } finally {
      // Unconditional — this operation must leave no persistent row regardless of what happened above.
      await sql`ROLLBACK`;
    }
    const afterRollbackRows = await sql.unsafe(`SELECT id FROM ${SCRATCH_TABLE_NAME} WHERE note = $1`, [testNote]);
    if (afterRollbackRows.length !== 0) {
      return { ok: false, reason: `${afterRollbackRows.length} row(s) unexpectedly persisted after ROLLBACK — the harmless operation is not actually harmless.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
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
  throw new Error(`Postgres did not become ready within ${timeoutMs}ms (last error: ${lastError?.message ?? lastError})`);
}

/** Writes the run-ownership marker `vitest.postgres.setup.ts` validates before any test runs. */
async function writeOwnershipMarker(databaseUrl, runToken) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _pg_test_harness_marker (token text primary key, created_at timestamptz not null default now())`;
    await sql`INSERT INTO _pg_test_harness_marker (token) VALUES (${runToken})`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

class HarnessFailure extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function main() {
  // STAGE 3 FINAL BLOCKER CLOSURE: fail before any Docker command — no container has been created yet,
  // so there is nothing for the unconditional `finally` cleanup to remove on this path.
  if (resolveStage3G03G04Only(process.argv) && resolveRunMode(process.argv) !== "run-tests") {
    console.error("[test:postgres] --stage3-g03-g04-only requires --run-tests to also be present.");
    process.exitCode = 1;
    return;
  }
  if (resolveStage4Only(process.argv) && resolveRunMode(process.argv) !== "run-tests") {
    console.error("[test:postgres] --stage4-only requires --run-tests to also be present.");
    process.exitCode = 1;
    return;
  }
  if (resolveStage5Only(process.argv) && resolveRunMode(process.argv) !== "run-tests") {
    console.error("[test:postgres] --stage5-only requires --run-tests to also be present.");
    process.exitCode = 1;
    return;
  }

  const requestedPort = process.env.POSTGRES_TEST_PORT;
  const portCheck = validateRequestedPort(requestedPort);
  if (!portCheck.ok) {
    console.error(`[test:postgres] ${portCheck.reason}`);
    process.exitCode = 1;
    return;
  }

  const containerName = generateContainerName();
  const runToken = randomUUID();
  const onWindows = process.platform === "win32";

  // FINAL corrective pass: cleanup is no longer gated on `docker run` having reported success (see
  // `removeThisRunContainer`'s own doc comment for exactly why that was a real container-leak bug) —
  // it always targets exactly this run's unique container name, on every exit path, and folds a
  // genuine removal failure into the process's final exit code even when everything else passed.
  // `finished` makes this idempotent: the normal `finally` path and a signal handler's own call can
  // never both attempt (and double-report) cleanup for the same run.
  let finished = false;
  const cleanupAndFinalize = () => {
    if (finished) return;
    finished = true;
    log(`stopping and removing this run's own container "${containerName}" (if it exists)`);
    const { exitCode, removalOk, removalError } = finalizeHarnessRun({ containerName, primaryExitCode: process.exitCode ?? 0 });
    if (!removalOk) {
      console.error(`[test:postgres] failed to remove this run's own container "${containerName}": ${removalError}`);
    }
    process.exitCode = exitCode;
  };
  // Ensure interruption (Ctrl+C, CI job cancellation) still removes exactly this run's container —
  // never any other run's, since `containerName` is captured per-process above — and that a cleanup
  // failure during interruption is still visible as a nonzero exit code.
  const onSignal = (signal) => {
    console.error(`[test:postgres] received ${signal} — cleaning up before exit`);
    process.exitCode = 130;
    cleanupAndFinalize();
    process.exit(process.exitCode);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    log(`starting disposable Postgres container "${containerName}" (image ${IMAGE}, run token ${runToken})`);
    const startResult = runCapture("docker", buildDockerRunArgs({ containerName, runToken, image: IMAGE, hostPort: requestedPort }));
    if (!startResult.ok) {
      console.error(startResult.stderr || startResult.error?.message || "docker run failed");
      // `docker run` can CREATE a container and claim its name even while reporting an overall
      // failure (e.g. it fails during start, after creation) — `cleanupAndFinalize` in `finally`
      // below still unconditionally attempts to remove `containerName`, whether or not one actually
      // exists, precisely to catch this case.
      throw new HarnessFailure("failed to start the disposable Postgres container — is Docker running?", 1);
    }

    let hostPort = requestedPort;
    if (!hostPort) {
      const portResult = runCapture("docker", ["port", containerName, "5432/tcp"]);
      if (!portResult.ok) throw new HarnessFailure("failed to discover the Docker-assigned host port", 1);
      hostPort = parseDockerPortOutput(portResult.stdout);
      if (!hostPort) throw new HarnessFailure(`could not parse assigned port from: ${portResult.stdout}`, 1);
    }
    // FINAL corrective pass, round 2 (Codex): validate the RESOLVED target — host and (possibly
    // Docker-assigned, not merely the original request) port — before this harness makes ANY
    // database connection at all (waitForReady, migrations, Vitest). Throwing here (inside this
    // `try`) still runs `finally`'s cleanup for this run's container and still exits nonzero.
    const resolvedHost = "127.0.0.1"; // matches buildDatabaseUrl's own hardcoded host.
    const targetCheck = validateResolvedTarget(resolvedHost, hostPort);
    if (!targetCheck.ok) {
      throw new HarnessFailure(`refusing to connect to a resolved database target that failed safety validation: ${targetCheck.reason}`, 1);
    }
    const databaseUrl = buildDatabaseUrl(hostPort);
    log(`Postgres will be reachable at 127.0.0.1:${hostPort} (container "${containerName}")`);

    // STAGE 2 CRITICAL REMEDIATION — FIX 01, step B: host-side target proof via independent Docker
    // metadata — never a name/localhost string alone. Runs BEFORE the first database connection.
    log("verifying host-side container identity via `docker inspect` (independent of the name this process itself generated)...");
    const inspectResult = runCapture("docker", ["inspect", containerName]);
    if (!inspectResult.ok) {
      throw new HarnessFailure("failed to inspect this run's own container via Docker — refusing to proceed without independent identity proof", 1);
    }
    const inspection = parseDockerInspectOutput(inspectResult.stdout);
    const containerIdentityCheck = verifyContainerIdentity({ inspection, containerName, runToken, expectedImage: IMAGE });
    if (!containerIdentityCheck.ok) {
      throw new HarnessFailure(`refusing to proceed — host-side container identity check failed: ${containerIdentityCheck.reason}`, 1);
    }
    log(`host-side identity confirmed (container id ${inspection.id.slice(0, 12)}..., image ${inspection.image}, running)`);

    log("waiting for Postgres to accept connections...");
    await waitForReady(databaseUrl);

    // FIX 01, step C: in-database identity proof — strictly before any schema/data write.
    log("verifying in-database identity before any schema/data write...");
    const identitySql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
    let dbIdentity;
    try {
      dbIdentity = await verifyDatabaseIdentity({ sql: identitySql, expectedDatabase: "postgres", expectedUser: "postgres" });
    } finally {
      await identitySql.end({ timeout: 1 }).catch(() => {});
    }
    if (!dbIdentity.ok) {
      throw new HarnessFailure(`refusing to proceed — in-database identity check failed: ${dbIdentity.reason}`, 1);
    }
    log(`in-database identity confirmed (current_database=postgres, current_user=postgres, server reports internal port ${dbIdentity.serverPort ?? "n/a"} — this need not equal the published host port ${hostPort})`);

    // FIX 01, step D: marker bootstrap immediately followed by its own verification — BEFORE
    // migrations, not after. Uses the SAME verifyHarnessOwnership function Vitest's own setup file
    // calls, so there is only one implementation of "what counts as a verified marker."
    log("bootstrapping and immediately verifying the run-ownership marker (before any migration)...");
    await writeOwnershipMarker(databaseUrl, runToken);
    await verifyHarnessOwnership({ databaseUrl, runToken });
    log("run-ownership marker verified.");

    log("applying repository migrations to the disposable database...");
    const migrateCode = run(process.execPath, [path.join(repoRoot, "scripts", "apply-migrations-fresh.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    if (migrateCode !== 0) {
      throw new HarnessFailure("migrations failed to apply to the disposable database — aborting before running any test", migrateCode);
    }

    // STAGE 2 CRITICAL REMEDIATION — FIX 03: create the coarse-grained reduced-privilege runtime role
    // AFTER migrations (which require the bootstrap role's DDL rights) but BEFORE the test suite is
    // ever invoked — see buildRuntimeRoleStatements's own doc comment for the exact, disclosed scope
    // of this reduction.
    log(`creating reduced-privilege runtime role "${RUNTIME_ROLE_NAME}" for actual test execution...`);
    const runtimePassword = randomBytes(24).toString("hex");
    const roleSql = postgres(databaseUrl, { max: 1, prepare: false });
    try {
      for (const statement of buildRuntimeRoleStatements(runtimePassword)) {
        await roleSql.unsafe(statement);
      }
      // STAGE 2 GATE B FINAL EVIDENCE COMPLETION — ORDER 03: the harmless scratch table, created
      // under the bootstrap role (the runtime role has no schema CREATE right, by design) and
      // granted only SELECT/INSERT to the runtime role.
      log("creating harmless scratch-verification table...");
      for (const statement of buildScratchTableStatements()) {
        await roleSql.unsafe(statement);
      }
    } finally {
      await roleSql.end({ timeout: 1 }).catch(() => {});
    }
    const runtimeDatabaseUrl = buildRuntimeDatabaseUrl(hostPort, runtimePassword);

    // STAGE 2 GATE B FINAL EVIDENCE COMPLETION — ORDER 02/03: connect AS the runtime role itself
    // (never the bootstrap connection) to confirm its actual, PostgreSQL-recorded effective identity,
    // attributes, and privileges, then perform one harmless real write-and-rollback. Runs
    // unconditionally, in BOTH validate-only and --run-tests modes — never gated behind --run-tests,
    // so this evidence exists even when the financial-recovery suite itself is never invoked. Any
    // failure here throws HarnessFailure, caught by this function's own existing outer catch, which
    // never falls back to the bootstrap role for anything — it only aborts and cleans up.
    log("verifying the runtime role's actual effective identity and privileges...");
    const runtimeVerifySql = postgres(runtimeDatabaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
    try {
      const identityCheck = await verifyRuntimeRoleIdentity({ sql: runtimeVerifySql });
      if (!identityCheck.ok) {
        throw new HarnessFailure(`refusing to proceed — runtime role identity check failed: ${identityCheck.reason}`, 1);
      }
      const attributesCheck = await verifyRuntimeRoleAttributes({ sql: runtimeVerifySql });
      if (!attributesCheck.ok) {
        throw new HarnessFailure(`refusing to proceed — runtime role attribute check failed: ${attributesCheck.reason}`, 1);
      }
      const markerCheck = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: runtimeVerifySql });
      if (!markerCheck.ok) {
        throw new HarnessFailure(`refusing to proceed — ownership-marker protection check failed: ${markerCheck.reason}`, 1);
      }
      for (const tableName of APPLICATION_TABLES_TO_VERIFY) {
        const tableCheck = await verifyApplicationTablePrivileges({ sql: runtimeVerifySql, tableName });
        if (!tableCheck.ok) {
          throw new HarnessFailure(`refusing to proceed — application-table privilege check failed: ${tableCheck.reason}`, 1);
        }
      }
      log("runtime role identity, attributes, marker protection, and application-table privileges all verified.");

      log("performing harmless scratch write-and-rollback verification...");
      const scratchResult = await performHarmlessScratchOperation({ sql: runtimeVerifySql });
      if (!scratchResult.ok) {
        throw new HarnessFailure(`refusing to proceed — harmless scratch operation failed: ${scratchResult.reason}`, 1);
      }
      log("harmless scratch write-and-rollback verification succeeded — no persistent row remains.");
    } finally {
      await runtimeVerifySql.end({ timeout: 1 }).catch(() => {});
    }

    const runMode = resolveRunMode(process.argv);
    if (runMode !== "run-tests") {
      // STAGE 2 CRITICAL REMEDIATION — FIX 01, approval separation: default mode stops HERE. The
      // financial-recovery suite is never invoked without an explicit `--run-tests` argument, which
      // `npm run test:postgres` (no arguments) can never supply.
      log(
        "GATE B VALIDATION MODE — container identity, in-database identity, ownership marker, migrations, the reduced-privilege runtime role, its actual effective identity/attributes/privileges, and the harmless scratch write-and-rollback all succeeded. " +
          "STOPPING WITHOUT running the *.postgres.test.ts financial-recovery suite. " +
          "Re-invoke as `node scripts/postgres-test-db.mjs --run-tests` only after the Phase B report has been reviewed and the owner has acknowledged Gate B.",
      );
      process.exitCode = 0;
    } else {
      const stage3G03G04Only = resolveStage3G03G04Only(process.argv);
      const stage4Only = resolveStage4Only(process.argv);
      const stage5Only = resolveStage5Only(process.argv);
      const vitestArgs = ["vitest", "run", "--config", "vitest.postgres.config.ts"];
      if (stage5Only) {
        vitestArgs.push(...STAGE5_POSTGRES_TEST_FILES);
        log(`STAGE 5 — running ONLY the fixed Stage 5 postgres test files: ${STAGE5_POSTGRES_TEST_FILES.join(", ")}...`);
      } else if (stage4Only) {
        vitestArgs.push(...STAGE4_POSTGRES_TEST_FILES);
        log(`STAGE 4 — running ONLY the fixed Stage 4 postgres test files: ${STAGE4_POSTGRES_TEST_FILES.join(", ")}...`);
      } else if (stage3G03G04Only) {
        // STAGE 3 FINAL BLOCKER CLOSURE: fixed, single-purpose selection — one explicit file path plus
        // a fixed test-name regex matching the two Stage 3 G03/G04 test names as substrings of
        // Vitest's own full nested title (never anchored with ^$, so a describe-block prefix still
        // matches), never an arbitrary user-supplied filter.
        // STAGE 3 FINAL BLOCKER CLOSURE — real-run diagnosis: on Windows, `run()` invokes `spawnSync`
        // with `shell: true` (npx resolves to a .cmd shim), and Node does NOT escape array arguments
        // for cmd.exe in that mode — an unquoted `|` in this regex was parsed by cmd.exe itself as a
        // shell pipe operator, splitting this one argument into two invalid "commands" instead of
        // reaching Vitest at all (observed directly: `docs/remediation/stage03-g03-g04-evidence/`,
        // first run, exit 255, stderr "'STAGE3-G04-...' is not recognized as an internal or external
        // command"). Explicit double-quoting is the fix — cmd.exe treats a metacharacter inside a
        // double-quoted token as literal text; Windows' own child-process argument parser strips the
        // surrounding quotes before Vitest ever sees the string, so Vitest still receives the exact
        // unquoted regex.
        const stage3TestNamePattern = onWindows
          ? '"STAGE3-G03-REAL-FACTORY-POSTGRES-RECOVERY|STAGE3-G04-REAL-FACTORY-POSTGRES-RETRY-STATUS"'
          : "STAGE3-G03-REAL-FACTORY-POSTGRES-RECOVERY|STAGE3-G04-REAL-FACTORY-POSTGRES-RETRY-STATUS";
        vitestArgs.push("src/lib/payments/paymentWebhookRecovery.postgres.test.ts", "-t", stage3TestNamePattern);
        log("STAGE 3 FINAL BLOCKER CLOSURE — running ONLY the two named G03/G04 real-factory acceptance tests...");
      } else {
        log("running PostgreSQL integration/concurrency suites (*.postgres.test.ts) under the reduced-privilege runtime role...");
      }
      // npx resolves to a .cmd shim on Windows, which spawnSync cannot exec directly without a shell.
      const testCode = run("npx", vitestArgs, {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: runtimeDatabaseUrl,
          POSTGRES_TEST_RUN_TOKEN: runToken,
          // Exposed ONLY for src/db/indexExtraction.postgres.test.ts's own test-owned scratch
          // table DDL (CREATE/DROP a throwaway table+indexes it creates and drops itself,
          // outside the accepted schema) — the reduced-privilege runtime role above is
          // deliberately never granted CREATE on schema public (established Stage 3/4 harness
          // design, unchanged by this Stage) and legitimately cannot do that DDL itself. All
          // actual extraction QUERIES that test runs still go through DATABASE_URL /
          // runtimeDatabaseUrl above, same as every other test in this suite — this bootstrap
          // URL is used for schema setup/teardown only.
          POSTGRES_TEST_BOOTSTRAP_DATABASE_URL: databaseUrl,
        },
        shell: onWindows,
      });
      process.exitCode = testCode;
    }
  } catch (error) {
    if (error instanceof HarnessFailure) {
      console.error(`[test:postgres] ${error.message}`);
      process.exitCode = error.exitCode || 1;
    } else {
      console.error("[test:postgres] fatal error:", error);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanupAndFinalize();
  }
}

// Only run when executed directly (`node scripts/postgres-test-db.mjs`), not when imported by its
// own test file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
