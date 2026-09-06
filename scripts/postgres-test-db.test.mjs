import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDatabaseUrl,
  buildDockerRunArgs,
  computeFinalExitCode,
  finalizeHarnessRun,
  FORBIDDEN_PORTS,
  generateContainerName,
  parseDockerPortOutput,
  removeThisRunContainer,
  validateRequestedPort,
  validateResolvedTarget,
} from "./postgres-test-db.mjs";

// Pure/no-Docker tests for postgres-test-db.mjs's argument-construction and validation helpers —
// the script's actual side effects (starting/stopping a real Docker container, connecting to
// Postgres) aren't something a unit test should trigger, mirroring apply-migrations-fresh.test.mjs's
// identical restraint.

test("validateRequestedPort REJECTS port 54322 (this repo's own persistent local Supabase Postgres) before any docker start", () => {
  const result = validateRequestedPort("54322");
  assert.equal(result.ok, false, "port 54322 must be rejected");
  assert.match(result.reason, /54322/);
});

test("validateRequestedPort REJECTS port 5432 (the conventional system-default Postgres port)", () => {
  const result = validateRequestedPort("5432");
  assert.equal(result.ok, false);
});

// FINAL corrective pass (Codex): validateRequestedPort("054322") previously PASSED even though it
// numerically means port 54322 — the old code compared the raw string against FORBIDDEN_PORTS before
// ever parsing it numerically, so a non-canonical spelling (a leading zero) skipped that check
// entirely. These prove the fix: numeric normalization happens first, so no non-canonical spelling of
// a forbidden port can slip through.
test("validateRequestedPort REJECTS '054322' — a leading zero must not bypass the numeric port-54322 check", () => {
  const result = validateRequestedPort("054322");
  assert.equal(result.ok, false, "054322 numerically IS port 54322 and must be rejected");
  assert.match(result.reason, /054322/);
});

test("validateRequestedPort REJECTS '05432' — a leading zero must not bypass the numeric port-5432 check", () => {
  const result = validateRequestedPort("05432");
  assert.equal(result.ok, false, "05432 numerically IS port 5432 and must be rejected");
});

test("validateRequestedPort REJECTS the canonical forms '54322' and '5432' too (regression: the fix must not have broken the already-passing cases)", () => {
  assert.equal(validateRequestedPort("54322").ok, false);
  assert.equal(validateRequestedPort("5432").ok, false);
});

test("validateRequestedPort is synchronous — a forbidden port is rejected before any docker invocation could even be scheduled", () => {
  const result = validateRequestedPort("54322");
  assert.equal(result instanceof Promise, false, "must not be async; main() checks this and returns before generating a container name or touching docker at all");
  assert.equal(result.ok, false);
});

test("validateRequestedPort accepts an unset port (Docker will assign a random one)", () => {
  assert.equal(validateRequestedPort(undefined).ok, true);
  assert.equal(validateRequestedPort("").ok, true);
});

test("validateRequestedPort accepts a valid, non-forbidden explicit port", () => {
  assert.equal(validateRequestedPort("45987").ok, true);
});

test("validateRequestedPort rejects a non-numeric or out-of-range port", () => {
  assert.equal(validateRequestedPort("not-a-port").ok, false);
  assert.equal(validateRequestedPort("0").ok, false);
  assert.equal(validateRequestedPort("70000").ok, false);
});

test("FORBIDDEN_PORTS explicitly names 54322 and 5432", () => {
  assert.ok(FORBIDDEN_PORTS.has("54322"));
  assert.ok(FORBIDDEN_PORTS.has("5432"));
});

test("generateContainerName produces a distinct name on every call, never a fixed global name", () => {
  const a = generateContainerName();
  const b = generateContainerName();
  assert.notEqual(a, b, "two calls must never produce the same container name");
  assert.match(a, /^pay2pay-pgtest-\d+-[0-9a-f]+$/);
});

// Codex (nonblocking cleanup): this test's previous title claimed to prove port 54322 is rejected,
// but it supplied hostPort "45987" — it never actually exercised 54322 at all, and buildDockerRunArgs
// itself has no port-forbidding logic of its own (that's validateRequestedPort's job, covered above,
// and it runs BEFORE buildDockerRunArgs is ever called). What this test actually proves — correctly —
// is the interface-binding property below.
test("buildDockerRunArgs only ever binds to 127.0.0.1, never to all interfaces, regardless of which port is requested", () => {
  const args = buildDockerRunArgs({ containerName: "test-container", runToken: "tok", image: "postgres:17-alpine", hostPort: "45987" });
  const portMapping = args[args.indexOf("-p") + 1];
  assert.equal(portMapping, "127.0.0.1:45987:5432");
  assert.ok(portMapping.startsWith("127.0.0.1:"), "must never bind 0.0.0.0 or a bare port, which Docker would publish on ALL interfaces");
});

test("buildDockerRunArgs with no hostPort lets Docker assign a random port (empty host-port form)", () => {
  const args = buildDockerRunArgs({ containerName: "test-container", runToken: "tok", image: "postgres:17-alpine", hostPort: undefined });
  const portMapping = args[args.indexOf("-p") + 1];
  assert.equal(portMapping, "127.0.0.1::5432", "an empty host port lets Docker assign a random ephemeral one");
});

test("buildDockerRunArgs labels the container with the run token, for provable ownership", () => {
  const args = buildDockerRunArgs({ containerName: "test-container", runToken: "abc-123", image: "postgres:17-alpine", hostPort: "45987" });
  assert.ok(args.some((a) => a === "pay2pay-test-harness-run=abc-123"));
});

test("buildDockerRunArgs names the container with the exact generated name", () => {
  const args = buildDockerRunArgs({ containerName: "my-unique-name", runToken: "tok", image: "postgres:17-alpine", hostPort: "45987" });
  assert.equal(args[args.indexOf("--name") + 1], "my-unique-name");
});

test("buildDatabaseUrl points at 127.0.0.1, never a bare hostname that could resolve to something remote", () => {
  const url = buildDatabaseUrl("55987");
  assert.ok(url.startsWith("postgres://postgres:postgres@127.0.0.1:55987/"), `unexpected DATABASE_URL shape: ${url}`);
});

test("parseDockerPortOutput extracts the host port from a real `docker port` output shape", () => {
  assert.equal(parseDockerPortOutput("0.0.0.0:32768\n127.0.0.1:32768\n"), "32768");
  assert.equal(parseDockerPortOutput("127.0.0.1:45987"), "45987");
});

test("parseDockerPortOutput returns null for unparseable output rather than guessing", () => {
  assert.equal(parseDockerPortOutput(""), null);
  assert.equal(parseDockerPortOutput("garbage"), null);
});

// FINAL corrective pass, round 2 (Codex: "pre-contact database target validation" — Docker-discovered
// mapped ports were not validated against forbidden ports before DB connection). Pure/no-Docker tests
// for the RESOLVED-target validator `main()` now calls right after discovering the actual host/port,
// before any database connection is made.

test("validateResolvedTarget accepts 127.0.0.1 with a normal, non-forbidden port", () => {
  assert.equal(validateResolvedTarget("127.0.0.1", "55987").ok, true);
});

test("validateResolvedTarget rejects a non-loopback resolved host", () => {
  const result = validateResolvedTarget("0.0.0.0", "55987");
  assert.equal(result.ok, false);
  assert.match(result.reason, /loopback/);
});

test("validateResolvedTarget rejects a remote hostname as the resolved host", () => {
  assert.equal(validateResolvedTarget("example.com", "55987").ok, false);
});

test("validateResolvedTarget rejects a resolved port of 5432 even on an approved loopback host", () => {
  const result = validateResolvedTarget("127.0.0.1", "5432");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsafe/);
});

test("validateResolvedTarget rejects a resolved port of 54322 even on an approved loopback host", () => {
  assert.equal(validateResolvedTarget("127.0.0.1", "54322").ok, false);
});

test("validateResolvedTarget rejects a leading-zero-padded resolved-port equivalent of a forbidden port", () => {
  assert.equal(validateResolvedTarget("127.0.0.1", "054322").ok, false);
});

test("validateResolvedTarget rejects a malformed/invalid resolved port", () => {
  assert.equal(validateResolvedTarget("127.0.0.1", "not-a-port").ok, false);
});

// FINAL corrective pass (Codex: Docker startup/cleanup failure handling). `removeThisRunContainer`
// takes an injectable `spawnFn` specifically so these can exercise its real decision logic without a
// real Docker daemon — same restraint this file's header comment already states for the rest of the
// suite.

test("removeThisRunContainer issues exactly `docker rm -f <name>` for the exact name it was given — never a glob, a label filter, or any other run's name", () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = removeThisRunContainer("pay2pay-pgtest-123-abcd", fakeSpawn);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cmd: "docker", args: ["rm", "-f", "pay2pay-pgtest-123-abcd"] });
});

test("removeThisRunContainer treats 'No such container' as an already-clean no-op, not a failure (covers: docker run reported failure before ever creating a container)", () => {
  const fakeSpawn = () => ({ status: 1, stdout: "", stderr: "Error: No such container: pay2pay-pgtest-999-zzzz\n" });
  const result = removeThisRunContainer("pay2pay-pgtest-999-zzzz", fakeSpawn);
  assert.equal(result.ok, true, "nothing existed to clean up — this must never be reported as a cleanup failure");
});

test("removeThisRunContainer surfaces a genuine removal failure rather than silently ignoring it (covers: docker CREATED the container but startup failed, and removal of the leftover then also fails)", () => {
  const fakeSpawn = () => ({ status: 1, stdout: "", stderr: "Error response from daemon: removal of container pay2pay-pgtest-1-aaaa is already in progress\n" });
  const result = removeThisRunContainer("pay2pay-pgtest-1-aaaa", fakeSpawn);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /already in progress/);
});

// FINAL corrective pass, round 2 (Codex: "cleanup spawnSync error must never report success" — a
// spawn/process-level error is NOT independent proof that no container exists; only Docker's own
// "No such container" RESPONSE is benign. Every one of these must be treated as a genuine failure.)
test("removeThisRunContainer treats a missing docker binary (ENOENT) as a cleanup FAILURE, never as nothing-to-clean-up", () => {
  const fakeSpawn = () => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) });
  const result = removeThisRunContainer("pay2pay-pgtest-1-aaaa", fakeSpawn);
  assert.equal(result.ok, false, "ENOENT proves nothing about whether a container exists — must not be classified as benign");
  assert.match(result.stderr, /ENOENT/);
});

test("removeThisRunContainer treats EAGAIN (resource temporarily unavailable) as a cleanup FAILURE, never as success", () => {
  const fakeSpawn = () => ({ error: Object.assign(new Error("spawn docker EAGAIN"), { code: "EAGAIN" }) });
  const result = removeThisRunContainer("pay2pay-pgtest-1-aaaa", fakeSpawn);
  assert.equal(result.ok, false, "EAGAIN must never be silently reported as successful cleanup");
  assert.match(result.stderr, /EAGAIN/);
});

test("removeThisRunContainer treats EPERM as a cleanup FAILURE, never as success", () => {
  const fakeSpawn = () => ({ error: Object.assign(new Error("spawn docker EPERM"), { code: "EPERM" }) });
  const result = removeThisRunContainer("pay2pay-pgtest-1-aaaa", fakeSpawn);
  assert.equal(result.ok, false);
});

test("removeThisRunContainer treats a docker-daemon-communication-failure exit (nonzero, no 'No such container' text) as a cleanup FAILURE", () => {
  const fakeSpawn = () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n" });
  const result = removeThisRunContainer("pay2pay-pgtest-1-aaaa", fakeSpawn);
  assert.equal(result.ok, false);
});

// End-to-end via finalizeHarnessRun — the exact five scenarios Codex asked for by letter.
test("finalizeHarnessRun (A): successful tests + cleanup EAGAIN => nonzero exit code", () => {
  const fakeSpawn = () => ({ error: Object.assign(new Error("spawn docker EAGAIN"), { code: "EAGAIN" }) });
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-a-0001", primaryExitCode: 0, spawnFn: fakeSpawn });
  assert.equal(result.removalOk, false);
  assert.equal(result.exitCode, 1);
});

test("finalizeHarnessRun (B): successful tests + cleanup ENOENT => nonzero exit code", () => {
  const fakeSpawn = () => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) });
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-b-0002", primaryExitCode: 0, spawnFn: fakeSpawn });
  assert.equal(result.removalOk, false);
  assert.equal(result.exitCode, 1);
});

test("finalizeHarnessRun (C): successful tests + Docker's own 'No such container' response => benign, exit code stays 0", () => {
  const fakeSpawn = () => ({ status: 1, stdout: "", stderr: "Error: No such container: pay2pay-pgtest-c-0003\n" });
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-c-0003", primaryExitCode: 0, spawnFn: fakeSpawn });
  assert.equal(result.removalOk, true);
  assert.equal(result.exitCode, 0);
});

test("finalizeHarnessRun (D): failed tests + cleanup failure => remains nonzero (the original failure code, not masked or changed)", () => {
  const fakeSpawn = () => ({ error: Object.assign(new Error("spawn docker EAGAIN"), { code: "EAGAIN" }) });
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-d-0004", primaryExitCode: 1, spawnFn: fakeSpawn });
  assert.equal(result.removalOk, false);
  assert.equal(result.exitCode, 1);
});

test("finalizeHarnessRun (E): successful tests + normal successful cleanup => exit code 0", () => {
  const fakeSpawn = () => ({ status: 0, stdout: "", stderr: "" });
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-e-0005", primaryExitCode: 0, spawnFn: fakeSpawn });
  assert.equal(result.removalOk, true);
  assert.equal(result.exitCode, 0);
});

test("computeFinalExitCode never overwrites a nonzero primary exit code (migration/test/startup failures must remain nonzero regardless of cleanup)", () => {
  assert.equal(computeFinalExitCode(1, true), 1);
  assert.equal(computeFinalExitCode(2, false), 2);
  assert.equal(computeFinalExitCode(130, false), 130);
});

test("computeFinalExitCode turns a successful primary result nonzero when cleanup failed — tests passing must not mask a leaked container", () => {
  assert.equal(computeFinalExitCode(0, false), 1);
});

test("computeFinalExitCode leaves a successful primary result at 0 when cleanup also succeeded", () => {
  assert.equal(computeFinalExitCode(0, true), 0);
});

test("finalizeHarnessRun: startup failure after container creation — cleanup is still attempted for exactly this run's container, and a genuine cleanup failure makes the harness exit nonzero", () => {
  // Models the exact scenario Codex found: `docker run` reported failure (so the harness already
  // has a nonzero primaryExitCode, as main() sets via HarnessFailure) AFTER Docker had actually
  // created the named container — cleanup must still be attempted for that name (not skipped because
  // "docker run never succeeded"), and if removal ALSO fails, the harness's exit code must reflect it.
  const calls = [];
  const fakeSpawnRemovalFails = (cmd, args) => {
    calls.push(args);
    return { status: 1, stdout: "", stderr: "Error response from daemon: removal already in progress\n" };
  };
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-42-deadbeef", primaryExitCode: 1, spawnFn: fakeSpawnRemovalFails });
  assert.deepEqual(calls[0], ["rm", "-f", "pay2pay-pgtest-42-deadbeef"], "cleanup must be attempted regardless of the startup failure");
  assert.equal(result.removalOk, false);
  assert.equal(result.exitCode, 1, "already nonzero from the startup failure — must stay nonzero");
});

test("finalizeHarnessRun: tests otherwise passed (primaryExitCode 0) but cleanup failed — the harness must exit nonzero rather than silently report success", () => {
  const fakeSpawnRemovalFails = () => ({ status: 1, stdout: "", stderr: "Error response from daemon: removal already in progress\n" });
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-7-cafef00d", primaryExitCode: 0, spawnFn: fakeSpawnRemovalFails });
  assert.equal(result.removalOk, false);
  assert.equal(result.exitCode, 1);
});

test("finalizeHarnessRun: successful cleanup after successful tests reports exit code 0", () => {
  const fakeSpawnRemovalSucceeds = () => ({ status: 0, stdout: "", stderr: "" });
  const result = finalizeHarnessRun({ containerName: "pay2pay-pgtest-8-decaf000", primaryExitCode: 0, spawnFn: fakeSpawnRemovalSucceeds });
  assert.equal(result.removalOk, true);
  assert.equal(result.exitCode, 0);
});
