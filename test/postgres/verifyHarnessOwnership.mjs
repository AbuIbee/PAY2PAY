import postgres from "postgres";

/**
 * FINAL corrective pass, round 2 (Codex: "pre-contact database target validation" — this suite used
 * to create a Postgres client, and make real network contact, BEFORE any static check of the
 * target's host/port; only afterward did it decide whether that target was safe). Extracted out of
 * `vitest.postgres.setup.ts` into this plain, dependency-injectable module specifically so the
 * ordering guarantee below can be unit-tested directly (see this file's own `.test.mjs`), rather than
 * only exercised indirectly through a real Docker+Postgres run.
 *
 * Mandated ordering, enforced by `verifyHarnessOwnership` below:
 *   1. parse DATABASE_URL as a URL (never a regex-only sniff)
 *   2. static host/port/run-token checks — no network I/O at all
 *   3. only THEN is a database connection created and the network actually contacted
 *   4. verify the run-scoped ownership marker stored in that database
 *
 * Never: connect first and decide afterward whether the host/port was safe.
 */

const FORBIDDEN_PORTS = new Set(["5432", "54322"]);
const APPROVED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Pure, synchronous, no I/O — safe to unit-test directly. */
export function validatePort(portString) {
  if (!portString) {
    return { ok: false, reason: "no explicit port was given (an implicit default port is never acceptable here)." };
  }
  const asNumber = Number(portString);
  if (!Number.isInteger(asNumber) || asNumber < 1 || asNumber > 65535) {
    return { ok: false, reason: `"${portString}" is not a valid TCP port number.` };
  }
  // Canonical re-stringification closes the exact same "054322"-style leading-zero bypass fixed in
  // scripts/postgres-test-db.mjs's validateRequestedPort — see that function's own doc comment.
  const canonicalPort = String(asNumber);
  if (FORBIDDEN_PORTS.has(canonicalPort)) {
    return { ok: false, reason: `port ${canonicalPort} is a known shared/production-adjacent port and is rejected — this suite must never run against it.` };
  }
  return { ok: true };
}

/** Parses `rawUrl` as a URL and statically validates its protocol/host/port. Throws — never resolves — before any network contact could occur. Pure, synchronous, no I/O. */
export function parseAndValidateTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL is not a well-formed URL.");
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) {
    throw new Error(`DATABASE_URL's protocol must be postgres:// or postgresql://, got "${url.protocol}".`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets, e.g. "[::1]" -> "::1"
  if (!APPROVED_LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `DATABASE_URL's host "${hostname}" is not an approved loopback address (127.0.0.1 / localhost / ::1) — this suite must never run against a remote database.`,
    );
  }
  const portCheck = validatePort(url.port);
  if (!portCheck.ok) {
    throw new Error(`DATABASE_URL's port is unsafe: ${portCheck.reason}`);
  }
  return url;
}

/**
 * `connect` defaults to the real `postgres` package but is injectable specifically so tests can
 * prove it is NEVER called for any input that fails the static checks above (Codex: "Add
 * tooling/unit coverage proving the client/connect function is never called for: remote hostname,
 * port 5432, port 54322, ..., malformed/invalid port, missing harness run marker").
 */
export async function verifyHarnessOwnership({ databaseUrl, runToken, connect = postgres }) {
  if (!runToken) {
    throw new Error(
      "[postgres tests] Refusing to run — POSTGRES_TEST_RUN_TOKEN is not set. This suite must be launched via " +
        "`npm run test:postgres`, which provisions a disposable database and hands this process the token proving " +
        "it owns it. Never run this suite directly with an arbitrary DATABASE_URL.",
    );
  }

  // Static validation FIRST — no connection has been created, no network contact has been made yet.
  parseAndValidateTarget(databaseUrl ?? "");

  // Only now, after every static check above has passed, is a connection created and the network
  // actually contacted — to verify the run-scoped ownership marker.
  const sql = connect(databaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
  try {
    const rows = await sql`SELECT token FROM _pg_test_harness_marker WHERE token = ${runToken} LIMIT 1`;
    if (rows.length === 0) {
      const redacted = databaseUrl.replace(/:[^:@/]*@/, ":***@");
      throw new Error(
        `[postgres tests] Refusing to run — the database at "${redacted}" does not contain this run's ownership ` +
          "marker. This means DATABASE_URL points at a database this specific `npm run test:postgres` invocation " +
          "did not provision — possibly a stale/unrelated local Postgres instance. Never run this suite with a " +
          "manually-set DATABASE_URL; always launch it via `npm run test:postgres`.",
      );
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
