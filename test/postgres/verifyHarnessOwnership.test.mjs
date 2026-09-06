import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAndValidateTarget, validatePort, verifyHarnessOwnership } from "./verifyHarnessOwnership.mjs";

// FINAL corrective pass, round 2 (Codex: "pre-contact database target validation"). Pure/no-network
// tests for the static validator plus end-to-end proof, via an injected fake `connect`, that the
// database connection is NEVER created for any input that should have been rejected first —
// mirrors postgres-test-db.test.mjs's own identical restraint (no real Docker/Postgres here either).

test("validatePort rejects 5432", () => {
  const result = validatePort("5432");
  assert.equal(result.ok, false);
});

test("validatePort rejects 54322", () => {
  const result = validatePort("54322");
  assert.equal(result.ok, false);
});

test("validatePort rejects a leading-zero-padded forbidden port ('05432') — same canonicalization fix as scripts/postgres-test-db.mjs", () => {
  const result = validatePort("05432");
  assert.equal(result.ok, false);
});

test("validatePort rejects a malformed/non-numeric port", () => {
  assert.equal(validatePort("not-a-port").ok, false);
  assert.equal(validatePort("-1").ok, false);
  assert.equal(validatePort("70000").ok, false);
});

test("validatePort rejects an empty/missing port (an implicit default port is never acceptable)", () => {
  assert.equal(validatePort("").ok, false);
  assert.equal(validatePort(undefined).ok, false);
});

test("validatePort accepts a valid, non-forbidden port", () => {
  assert.equal(validatePort("55987").ok, true);
});

test("parseAndValidateTarget rejects a remote hostname", () => {
  assert.throws(() => parseAndValidateTarget("postgres://user:pass@example.com:55987/postgres"), /loopback/);
});

test("parseAndValidateTarget rejects port 5432 even on an otherwise-loopback host", () => {
  assert.throws(() => parseAndValidateTarget("postgres://user:pass@127.0.0.1:5432/postgres"), /unsafe/);
});

test("parseAndValidateTarget rejects port 54322 even on an otherwise-loopback host", () => {
  assert.throws(() => parseAndValidateTarget("postgres://user:pass@localhost:54322/postgres"), /unsafe/);
});

test("parseAndValidateTarget rejects a malformed URL", () => {
  assert.throws(() => parseAndValidateTarget("not a url at all"), /well-formed/);
});

test("parseAndValidateTarget accepts a genuinely safe target (127.0.0.1, non-forbidden port)", () => {
  const url = parseAndValidateTarget("postgres://postgres:postgres@127.0.0.1:55987/postgres");
  assert.equal(url.hostname, "127.0.0.1");
});

// End-to-end: verifyHarnessOwnership must never call `connect` for any of these — proven directly
// via an injected fake that records whether it was invoked, exactly as Codex asked.
async function assertNeverConnects(input, messagePattern) {
  const connect = () => {
    throw new Error("connect() must never be called before static validation passes");
  };
  let called = false;
  const trackedConnect = (...args) => {
    called = true;
    return connect(...args);
  };
  await assert.rejects(() => verifyHarnessOwnership({ ...input, connect: trackedConnect }), messagePattern);
  assert.equal(called, false, "connect() must never have been invoked");
}

test("verifyHarnessOwnership never connects for a remote hostname", async () => {
  await assertNeverConnects({ databaseUrl: "postgres://u:p@example.com:55987/postgres", runToken: "tok" }, /loopback/);
});

test("verifyHarnessOwnership never connects for port 5432", async () => {
  await assertNeverConnects({ databaseUrl: "postgres://u:p@127.0.0.1:5432/postgres", runToken: "tok" }, /unsafe/);
});

test("verifyHarnessOwnership never connects for port 54322", async () => {
  await assertNeverConnects({ databaseUrl: "postgres://u:p@127.0.0.1:54322/postgres", runToken: "tok" }, /unsafe/);
});

test("verifyHarnessOwnership never connects for a leading-zero-padded forbidden port equivalent ('054322')", async () => {
  await assertNeverConnects({ databaseUrl: "postgres://u:p@127.0.0.1:054322/postgres", runToken: "tok" }, /unsafe/);
});

test("verifyHarnessOwnership never connects for a malformed/invalid port", async () => {
  await assertNeverConnects({ databaseUrl: "postgres://u:p@127.0.0.1:not-a-port/postgres", runToken: "tok" }, /unsafe|well-formed/);
});

test("verifyHarnessOwnership never connects when the harness run-token env var is missing", async () => {
  await assertNeverConnects({ databaseUrl: "postgres://u:p@127.0.0.1:55987/postgres", runToken: undefined }, /POSTGRES_TEST_RUN_TOKEN/);
});

test("verifyHarnessOwnership DOES connect once every static check passes, and verifies the ownership marker", async () => {
  const calls = [];
  const connect = (url, opts) => {
    calls.push({ url, opts });
    return Object.assign(
      async () => [{ token: "tok" }],
      { end: async () => {} },
    );
  };
  await verifyHarnessOwnership({ databaseUrl: "postgres://u:p@127.0.0.1:55987/postgres", runToken: "tok", connect });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "postgres://u:p@127.0.0.1:55987/postgres");
});

test("verifyHarnessOwnership rejects when the database has no matching ownership marker, even though it did connect", async () => {
  const connect = () =>
    Object.assign(async () => [], { end: async () => {} });
  await assert.rejects(
    () => verifyHarnessOwnership({ databaseUrl: "postgres://u:p@127.0.0.1:55987/postgres", runToken: "tok", connect }),
    /does not contain this run's ownership/,
  );
});
