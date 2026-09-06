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

    log("waiting for Postgres to accept connections...");
    await waitForReady(databaseUrl);

    log("applying repository migrations to the disposable database...");
    const migrateCode = run(process.execPath, [path.join(repoRoot, "scripts", "apply-migrations-fresh.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    if (migrateCode !== 0) {
      throw new HarnessFailure("migrations failed to apply to the disposable database — aborting before running any test", migrateCode);
    }

    log("writing run-ownership marker...");
    await writeOwnershipMarker(databaseUrl, runToken);

    log("running PostgreSQL integration/concurrency suites (*.postgres.test.ts)...");
    // npx resolves to a .cmd shim on Windows, which spawnSync cannot exec directly without a shell.
    const testCode = run("npx", ["vitest", "run", "--config", "vitest.postgres.config.ts"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, POSTGRES_TEST_RUN_TOKEN: runToken },
      shell: onWindows,
    });
    process.exitCode = testCode;
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
