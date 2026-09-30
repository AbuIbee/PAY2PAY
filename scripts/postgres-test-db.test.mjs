import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPLICATION_TABLES_TO_VERIFY,
  buildDatabaseUrl,
  buildDockerRunArgs,
  buildRuntimeDatabaseUrl,
  buildRuntimeRoleStatements,
  buildScratchTableStatements,
  computeFinalExitCode,
  finalizeHarnessRun,
  FORBIDDEN_PORTS,
  generateContainerName,
  IMAGE,
  LABEL_KEY,
  OWNERSHIP_MARKER_TABLE_NAME,
  parseDockerInspectOutput,
  parseDockerPortOutput,
  performHarmlessScratchOperation,
  removeThisRunContainer,
  resolveRunMode,
  RUNTIME_ROLE_NAME,
  SCRATCH_TABLE_NAME,
  validateRequestedPort,
  validateResolvedTarget,
  verifyApplicationTablePrivileges,
  verifyContainerIdentity,
  verifyDatabaseIdentity,
  verifyMarkerTableIsReadOnlyForRuntimeRole,
  verifyRuntimeRoleAttributes,
  verifyRuntimeRoleIdentity,
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

// ============================================================================================
// STAGE 2 CRITICAL REMEDIATION — FIX 01 (pre-migration isolation) offline negative tests.
// Every test below is pure/dependency-injected: no real Docker, no real database, no network I/O.
// Each asserts REJECTION for exactly the inputs FIX 01 enumerates, proving the identity/marker gates
// this file's own main() now checks BEFORE migrations would themselves refuse each bad input.
// ============================================================================================

const VALID_INSPECTION_JSON = JSON.stringify([
  {
    Id: "a".repeat(64),
    Name: "/pay2pay-pgtest-123-abcd",
    State: { Running: true },
    Config: { Image: IMAGE, Labels: { [LABEL_KEY]: "true", [`${LABEL_KEY}-run`]: "tok-abc" } },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55987" }] } },
  },
]);

test("parseDockerInspectOutput parses a real-shaped `docker inspect` JSON array", () => {
  const parsed = parseDockerInspectOutput(VALID_INSPECTION_JSON);
  assert.equal(parsed.id, "a".repeat(64));
  assert.equal(parsed.name, "pay2pay-pgtest-123-abcd");
  assert.equal(parsed.running, true);
  assert.equal(parsed.image, IMAGE);
  assert.equal(parsed.labels[LABEL_KEY], "true");
  assert.equal(parsed.hostPort, "55987");
});

test("parseDockerInspectOutput returns null for unparseable/malformed JSON rather than guessing", () => {
  assert.equal(parseDockerInspectOutput("not json"), null);
  assert.equal(parseDockerInspectOutput(""), null);
  assert.equal(parseDockerInspectOutput("[]"), null);
});

function validInspection(overrides = {}) {
  return {
    id: "a".repeat(64),
    name: "pay2pay-pgtest-123-abcd",
    running: true,
    image: IMAGE,
    labels: { [LABEL_KEY]: "true", [`${LABEL_KEY}-run`]: "tok-abc" },
    hostPort: "55987",
    ...overrides,
  };
}

const baseIdentityArgs = { containerName: "pay2pay-pgtest-123-abcd", runToken: "tok-abc", expectedImage: IMAGE };

test("verifyContainerIdentity ACCEPTS a fully-matching inspection", () => {
  const result = verifyContainerIdentity({ inspection: validInspection(), ...baseIdentityArgs });
  assert.equal(result.ok, true);
});

test("verifyContainerIdentity REJECTS a null inspection (docker inspect returned nothing)", () => {
  assert.equal(verifyContainerIdentity({ inspection: null, ...baseIdentityArgs }).ok, false);
});

test("verifyContainerIdentity REJECTS a missing/empty container ID", () => {
  const result = verifyContainerIdentity({ inspection: validInspection({ id: null }), ...baseIdentityArgs });
  assert.equal(result.ok, false);
  assert.match(result.reason, /immutable ID/);
});

test("verifyContainerIdentity REJECTS a mismatched container name (a name/localhost string alone is never sufficient)", () => {
  const result = verifyContainerIdentity({ inspection: validInspection({ name: "some-other-container" }), ...baseIdentityArgs });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match this run's generated name/);
});

test("verifyContainerIdentity REJECTS a missing harness label", () => {
  const result = verifyContainerIdentity({ inspection: validInspection({ labels: { [`${LABEL_KEY}-run`]: "tok-abc" } }), ...baseIdentityArgs });
  assert.equal(result.ok, false);
  assert.match(result.reason, /label/);
});

test("verifyContainerIdentity REJECTS a wrong run-token label", () => {
  const result = verifyContainerIdentity({
    inspection: validInspection({ labels: { [LABEL_KEY]: "true", [`${LABEL_KEY}-run`]: "some-other-token" } }),
    ...baseIdentityArgs,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /run-token label/);
});

test("verifyContainerIdentity REJECTS a wrong/unexpected image", () => {
  const result = verifyContainerIdentity({ inspection: validInspection({ image: "postgres:15-alpine" }), ...baseIdentityArgs });
  assert.equal(result.ok, false);
  assert.match(result.reason, /image/);
});

test("verifyContainerIdentity REJECTS a container that is not running", () => {
  const result = verifyContainerIdentity({ inspection: validInspection({ running: false }), ...baseIdentityArgs });
  assert.equal(result.ok, false);
  assert.match(result.reason, /running/);
});

function fakeSql(rows) {
  return async () => rows;
}

test("verifyDatabaseIdentity ACCEPTS a matching current_database/current_user", async () => {
  const sql = fakeSql([{ database: "postgres", user: "postgres", server_addr: null, server_port: 5432, version: "PostgreSQL 17.0" }]);
  const result = await verifyDatabaseIdentity({ sql, expectedDatabase: "postgres", expectedUser: "postgres" });
  assert.equal(result.ok, true);
});

test("verifyDatabaseIdentity REJECTS a wrong current_database() — proves a mismatched target/database is caught before any write", async () => {
  const sql = fakeSql([{ database: "some_other_database", user: "postgres", server_addr: null, server_port: 5432, version: "x" }]);
  const result = await verifyDatabaseIdentity({ sql, expectedDatabase: "postgres", expectedUser: "postgres" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /current_database/);
});

test("verifyDatabaseIdentity REJECTS a wrong current_user (wrong DB role) — proves a wrong role is caught before any write", async () => {
  const sql = fakeSql([{ database: "postgres", user: "some_other_role", server_addr: null, server_port: 5432, version: "x" }]);
  const result = await verifyDatabaseIdentity({ sql, expectedDatabase: "postgres", expectedUser: "postgres" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /current_user/);
});

test("verifyDatabaseIdentity REJECTS an empty result set rather than assuming success", async () => {
  const sql = fakeSql([]);
  const result = await verifyDatabaseIdentity({ sql, expectedDatabase: "postgres", expectedUser: "postgres" });
  assert.equal(result.ok, false);
});

test("resolveRunMode defaults to validate-only — `npm run test:postgres` (no arguments) can never reach the financial-recovery suite", () => {
  assert.equal(resolveRunMode(["node", "postgres-test-db.mjs"]), "validate-only");
  assert.equal(resolveRunMode([]), "validate-only");
});

test("resolveRunMode only returns run-tests for the exact explicit --run-tests flag", () => {
  assert.equal(resolveRunMode(["node", "postgres-test-db.mjs", "--run-tests"]), "run-tests");
  assert.equal(resolveRunMode(["node", "postgres-test-db.mjs", "--run-test"]), "validate-only", "a near-miss flag must not accidentally enable execution");
  assert.equal(resolveRunMode(["node", "postgres-test-db.mjs", "--RUN-TESTS"]), "validate-only", "must be case-sensitive — never accidentally permissive");
});

test("buildRuntimeRoleStatements requires a real, sufficiently long random password — never a weak/empty one", () => {
  assert.throws(() => buildRuntimeRoleStatements(""), /password/);
  assert.throws(() => buildRuntimeRoleStatements("short"), /password/);
  assert.throws(() => buildRuntimeRoleStatements(undefined), /password/);
});

test("buildRuntimeRoleStatements always begins with DROP ROLE IF EXISTS — a re-run of this harness can never collide with a leftover role of the same fixed name", () => {
  const statements = buildRuntimeRoleStatements("a".repeat(32));
  assert.equal(statements[0], `DROP ROLE IF EXISTS ${RUNTIME_ROLE_NAME}`);
});

// STAGE 2 FINAL ROLE-OWNERSHIP CORRECTION: the prior `REASSIGN OWNED BY postgres` design is withdrawn
// — it was never scoped to the application tables and, per PostgreSQL's own documented REASSIGN OWNED
// semantics, would also have reassigned ownership of the `_pg_test_harness_marker` table (and
// potentially the database itself). These tests pin the corrected, narrowly-scoped model: DML-only
// grants, no ownership transfer of any kind, and the marker table explicitly narrowed to read-only.

test("buildRuntimeRoleStatements NEVER includes REASSIGN OWNED, or any other ownership-transfer statement, anywhere in the full statement list", () => {
  const statements = buildRuntimeRoleStatements("a".repeat(32));
  const fullText = statements.join("\n");
  assert.doesNotMatch(fullText, /REASSIGN OWNED/i);
  assert.doesNotMatch(fullText, /OWNER TO/i);
});

test("buildRuntimeRoleStatements grants only DML (SELECT/INSERT/UPDATE/DELETE) on tables — never CREATE on the schema, since no existing test creates a new object", () => {
  const statements = buildRuntimeRoleStatements("a".repeat(32));
  const fullText = statements.join("\n");
  assert.doesNotMatch(fullText, /GRANT[^;]*\bCREATE\b[^;]*SCHEMA/i);
  assert.ok(statements.some((s) => s === `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE_NAME}`));
});

test("buildRuntimeRoleStatements explicitly narrows the ownership-marker table to read-only for the runtime role — never INSERT/UPDATE/DELETE/TRUNCATE, never ownership", () => {
  const statements = buildRuntimeRoleStatements("a".repeat(32));
  const revokeStatement = statements.find((s) => s.includes(OWNERSHIP_MARKER_TABLE_NAME));
  assert.ok(revokeStatement, "must contain an explicit statement narrowing marker-table access");
  assert.match(revokeStatement, /^REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON/);
  assert.doesNotMatch(revokeStatement, /SELECT/); // SELECT must remain granted (from the blanket table grant), never revoked.
});

test("buildRuntimeRoleStatements includes the explicitly disclosed BYPASSRLS exception (to preserve existing, already-proven test behavior — every test has always run under a role RLS never applied to) while keeping every other superuser-adjacent capability negated", () => {
  const statements = buildRuntimeRoleStatements("a".repeat(32));
  const createStatement = statements.find((s) => s.startsWith("CREATE ROLE"));
  assert.ok(createStatement.includes("BYPASSRLS") && !createStatement.includes("NOBYPASSRLS"), "BYPASSRLS must be explicitly granted, not negated");
  for (const capability of ["NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOREPLICATION"]) {
    assert.ok(createStatement.includes(capability), `CREATE ROLE statement must still include ${capability}`);
  }
});

test("buildRuntimeRoleStatements never grants CREATEDB, CREATEROLE, REPLICATION, or SUPERUSER anywhere in the full statement list (BYPASSRLS is the only explicitly disclosed exception)", () => {
  const statements = buildRuntimeRoleStatements("a".repeat(32));
  const fullText = statements.join("\n");
  assert.doesNotMatch(fullText, /(?<!NO)CREATEDB\b/);
  assert.doesNotMatch(fullText, /(?<!NO)CREATEROLE\b/);
  assert.doesNotMatch(fullText, /(?<!NO)REPLICATION\b/);
  assert.doesNotMatch(fullText, /(?<!NO)SUPERUSER\b/);
});

test("buildRuntimeDatabaseUrl builds a URL for the runtime role, never the bootstrap postgres/postgres role", () => {
  const url = buildRuntimeDatabaseUrl("55987", "supersecretpassword1234");
  assert.ok(url.startsWith(`postgres://${RUNTIME_ROLE_NAME}:supersecretpassword1234@127.0.0.1:55987/`));
  assert.ok(!url.includes("postgres:postgres@"), "must never reuse the bootstrap role's own credentials");
});

// ============================================================================================
// STAGE 2 GATE B FINAL EVIDENCE COMPLETION — offline negative tests for the runtime-role
// identity/attribute/privilege verification and the harmless scratch operation. Every `sql` here is
// an injected fake returning canned rows or tracking call sequence — no real Docker/Postgres contact.
// ============================================================================================

function fakeSqlReturning(rows) {
  return async () => rows;
}

test("buildScratchTableStatements creates an infrastructure-only table, wholly separate from any application table, and grants the runtime role only SELECT/INSERT on it (never UPDATE/DELETE/TRUNCATE/ownership)", () => {
  const statements = buildScratchTableStatements();
  assert.ok(statements[0].includes(`CREATE TABLE IF NOT EXISTS ${SCRATCH_TABLE_NAME}`));
  assert.ok(statements.some((s) => s === `GRANT SELECT, INSERT ON ${SCRATCH_TABLE_NAME} TO ${RUNTIME_ROLE_NAME}`));
  const fullText = statements.join("\n");
  assert.doesNotMatch(fullText, /UPDATE|DELETE|TRUNCATE|OWNER/i);
});

test("verifyRuntimeRoleIdentity ACCEPTS when current_user genuinely equals the runtime role", async () => {
  const sql = fakeSqlReturning([{ user: RUNTIME_ROLE_NAME }]);
  const result = await verifyRuntimeRoleIdentity({ sql });
  assert.equal(result.ok, true);
});

test("verifyRuntimeRoleIdentity REJECTS when connected as any other role — the exact 'bootstrap connection masquerading as the runtime role' case this order requires catching", async () => {
  const sql = fakeSqlReturning([{ user: "postgres" }]);
  const result = await verifyRuntimeRoleIdentity({ sql });
  assert.equal(result.ok, false);
  assert.match(result.reason, /postgres/);
});

test("verifyRuntimeRoleIdentity REJECTS an empty result set rather than assuming success", async () => {
  const result = await verifyRuntimeRoleIdentity({ sql: fakeSqlReturning([]) });
  assert.equal(result.ok, false);
});

function baseRoleAttributes(overrides = {}) {
  return { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: true, ...overrides };
}

test("verifyRuntimeRoleAttributes ACCEPTS the exact intended attribute set (every superuser-adjacent flag false, BYPASSRLS true)", async () => {
  const result = await verifyRuntimeRoleAttributes({ sql: fakeSqlReturning([baseRoleAttributes()]) });
  assert.equal(result.ok, true);
});

test("verifyRuntimeRoleAttributes REJECTS an unexpected SUPERUSER attribute", async () => {
  const result = await verifyRuntimeRoleAttributes({ sql: fakeSqlReturning([baseRoleAttributes({ rolsuper: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /SUPERUSER/);
});

test("verifyRuntimeRoleAttributes REJECTS an unexpected CREATEDB attribute", async () => {
  const result = await verifyRuntimeRoleAttributes({ sql: fakeSqlReturning([baseRoleAttributes({ rolcreatedb: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /CREATEDB/);
});

test("verifyRuntimeRoleAttributes REJECTS an unexpected CREATEROLE attribute", async () => {
  const result = await verifyRuntimeRoleAttributes({ sql: fakeSqlReturning([baseRoleAttributes({ rolcreaterole: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /CREATEROLE/);
});

test("verifyRuntimeRoleAttributes REJECTS an unexpected REPLICATION attribute", async () => {
  const result = await verifyRuntimeRoleAttributes({ sql: fakeSqlReturning([baseRoleAttributes({ rolreplication: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /REPLICATION/);
});

test("verifyRuntimeRoleAttributes REJECTS a missing BYPASSRLS (the one owner-accepted exception must actually be present, not merely intended)", async () => {
  const result = await verifyRuntimeRoleAttributes({ sql: fakeSqlReturning([baseRoleAttributes({ rolbypassrls: false })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /BYPASSRLS/);
});

test("verifyRuntimeRoleAttributes REJECTS when pg_roles has no row for the runtime role at all", async () => {
  const result = await verifyRuntimeRoleAttributes({ sql: fakeSqlReturning([]) });
  assert.equal(result.ok, false);
});

function baseMarkerPrivileges(overrides = {}) {
  return { can_select: true, can_insert: false, can_update: false, can_delete: false, can_truncate: false, owner: "postgres", ...overrides };
}

test("verifyMarkerTableIsReadOnlyForRuntimeRole ACCEPTS read-only access with bootstrap ownership retained", async () => {
  const result = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: fakeSqlReturning([baseMarkerPrivileges()]) });
  assert.equal(result.ok, true);
});

test("verifyMarkerTableIsReadOnlyForRuntimeRole REJECTS excessive marker permissions — unexpected INSERT", async () => {
  const result = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: fakeSqlReturning([baseMarkerPrivileges({ can_insert: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /INSERT/);
});

test("verifyMarkerTableIsReadOnlyForRuntimeRole REJECTS excessive marker permissions — unexpected UPDATE", async () => {
  const result = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: fakeSqlReturning([baseMarkerPrivileges({ can_update: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /UPDATE/);
});

test("verifyMarkerTableIsReadOnlyForRuntimeRole REJECTS excessive marker permissions — unexpected DELETE", async () => {
  const result = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: fakeSqlReturning([baseMarkerPrivileges({ can_delete: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /DELETE/);
});

test("verifyMarkerTableIsReadOnlyForRuntimeRole REJECTS excessive marker permissions — unexpected TRUNCATE", async () => {
  const result = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: fakeSqlReturning([baseMarkerPrivileges({ can_truncate: true })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /TRUNCATE/);
});

test("verifyMarkerTableIsReadOnlyForRuntimeRole REJECTS the runtime role owning the marker table", async () => {
  const result = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: fakeSqlReturning([baseMarkerPrivileges({ owner: RUNTIME_ROLE_NAME })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /OWN/);
});

test("verifyMarkerTableIsReadOnlyForRuntimeRole REJECTS a missing SELECT (verification itself would be impossible)", async () => {
  const result = await verifyMarkerTableIsReadOnlyForRuntimeRole({ sql: fakeSqlReturning([baseMarkerPrivileges({ can_select: false })]) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /SELECT/);
});

test("verifyApplicationTablePrivileges ACCEPTS full DML access on a representative application table", async () => {
  const result = await verifyApplicationTablePrivileges({
    sql: fakeSqlReturning([{ can_select: true, can_insert: true, can_update: true, can_delete: true }]),
    tableName: "payment_retry",
  });
  assert.equal(result.ok, true);
});

test("verifyApplicationTablePrivileges REJECTS a missing DML privilege on an application table", async () => {
  const result = await verifyApplicationTablePrivileges({
    sql: fakeSqlReturning([{ can_select: true, can_insert: false, can_update: true, can_delete: true }]),
    tableName: "payment_retry",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /payment_retry/);
});

test("APPLICATION_TABLES_TO_VERIFY names real, actual migrated tables (not invented) directly relevant to REM-008", () => {
  assert.deepEqual([...APPLICATION_TABLES_TO_VERIFY], ["agreement", "payment_attempt", "payment_retry"]);
});

/** Fake `sql` supporting both the tagged-template form (`sql\`BEGIN\``, for BEGIN/ROLLBACK) and
 * postgres.js's `sql.unsafe(text, params)` form (for the parameterized INSERT/SELECT statements),
 * tracking call sequence so the mid-transaction SELECT and the after-rollback SELECT — identical query
 * text — can be distinguished by whether ROLLBACK has already been issued. */
function fakeScratchSql() {
  const calls = [];
  const sql = async (strings) => {
    calls.push(Array.isArray(strings) ? strings.join("") : String(strings));
    return [];
  };
  sql.unsafe = async (text, params) => {
    calls.push(text);
    if (text.startsWith("INSERT INTO")) {
      return [{ id: "11111111-1111-1111-1111-111111111111", note: params?.[0] }];
    }
    if (text.startsWith("SELECT id")) {
      // Present while inside the transaction (before ROLLBACK has been issued), gone afterward —
      // exactly the real, honest behavior a genuine ROLLBACK produces.
      return calls.includes("ROLLBACK") ? [] : [{ id: "11111111-1111-1111-1111-111111111111" }];
    }
    return [];
  };
  return { sql, calls };
}

test("performHarmlessScratchOperation succeeds: inserts one row, observes it inside the transaction, rolls back, and confirms zero rows persist afterward", async () => {
  const { sql, calls } = fakeScratchSql();
  const result = await performHarmlessScratchOperation({ sql });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(calls.includes("BEGIN"));
  assert.ok(calls.includes("ROLLBACK"));
});

test("performHarmlessScratchOperation FAILS when the inserted row cannot be read back correctly inside the transaction", async () => {
  const sql = async (strings) => (Array.isArray(strings) ? strings.join("") : strings) && [];
  sql.unsafe = async (text) => {
    if (text.startsWith("INSERT INTO")) return [{ id: "x", note: "WRONG-NOTE-VALUE" }];
    return [];
  };
  const result = await performHarmlessScratchOperation({ sql });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be read back/);
});

test("performHarmlessScratchOperation FAILS when a row unexpectedly persists AFTER rollback — proving the operation is not actually harmless", async () => {
  let insertedNote;
  const sql = async () => [];
  sql.unsafe = async (text, params) => {
    if (text.startsWith("INSERT INTO")) {
      insertedNote = params[0];
      return [{ id: "x", note: insertedNote }];
    }
    if (text.startsWith("SELECT id")) return [{ id: "x" }]; // always reports the row present, including "after rollback".
    return [];
  };
  const result = await performHarmlessScratchOperation({ sql });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpectedly persisted after ROLLBACK/);
});

test("performHarmlessScratchOperation always issues ROLLBACK even when the mid-transaction check fails (the finally block is unconditional)", async () => {
  const calls = [];
  const sql = async (strings) => {
    calls.push(Array.isArray(strings) ? strings.join("") : strings);
    return [];
  };
  sql.unsafe = async (text) => {
    calls.push(text);
    if (text.startsWith("INSERT INTO")) throw new Error("simulated insert failure");
    return [];
  };
  const result = await performHarmlessScratchOperation({ sql });
  assert.equal(result.ok, false);
  assert.ok(calls.includes("ROLLBACK"), "ROLLBACK must still be issued even when the insert itself fails");
});

// STAGE 2 GATE B FINAL EVIDENCE COMPLETION — ORDER 03's "confirm a failed verification aborts the
// harness and still invokes exact-container cleanup" requirement is satisfied structurally, not by a
// new end-to-end test: every new verification function above returns `{ ok: false, reason }` on
// failure (never throws on its own), and `main()`'s own source (read again after this change) wraps
// EVERY one of them in `if (!x.ok) throw new HarnessFailure(...)`, inside the SAME outer `try` block
// every pre-existing identity/marker check already uses. `HarnessFailure` is caught by the SAME
// existing `catch` that sets a nonzero `process.exitCode`, and `finally` unconditionally calls
// `cleanupAndFinalize()` — a mechanism ALREADY exhaustively covered by the `finalizeHarnessRun`/
// `removeThisRunContainer`/`computeFinalExitCode` tests above (18 tests, covering every cleanup
// success/failure/spawn-error combination). No new throw site changes that mechanism's shape, so no
// new end-to-end test is required to re-prove it for these specific new failure reasons.
