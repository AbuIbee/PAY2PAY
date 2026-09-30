// R07 (DB integrity & concurrency hardening) — corrective pass. Setup for the *.postgres.test.ts
// suite only. Deliberately does NOT reuse vitest.setup.ts (jsdom/testing-library globals, React
// cleanup — all irrelevant here, and testing-library's cleanup() assumes a DOM that this suite's
// "node" environment never provides).
//
// This is the one hard safety rule the whole suite exists to uphold: these tests run real DDL/DML
// against whatever DATABASE_URL points to, so they must NEVER be allowed to run against Supabase
// production, Vercel production, this repository's own long-running local Supabase Postgres, or any
// other database this specific harness invocation did not itself provision.
//
// FINAL corrective pass, round 2 (Codex: "pre-contact database target validation" — this file used
// to create a Postgres client, and make real network contact, BEFORE any static check of the
// target's host/port). All of that parsing/validation/connection logic now lives in
// test/postgres/verifyHarnessOwnership.mjs — a plain, dependency-injectable module unit-tested
// directly (see that file's own .test.mjs, run via `npm run test:tooling`) — so this thin setup file
// has nothing left to get the ordering wrong: it just awaits that one call before anything else here
// runs.
import { verifyHarnessOwnership } from "./test/postgres/verifyHarnessOwnership.mjs";
import { clearNotificationCredentials, installDefaultDenyOutboundGuard } from "./test/postgres/outboundTransportGuard.mjs";

await verifyHarnessOwnership({
  databaseUrl: process.env.DATABASE_URL,
  runToken: process.env.POSTGRES_TEST_RUN_TOKEN,
});

// STAGE 2 CRITICAL REMEDIATION — FIX 02: default-deny outbound network traffic for the entire
// PostgreSQL integration-test process. Installed once, for the whole single-fork worker this suite's
// own `vitest.postgres.config.ts` runs as — see outboundTransportGuard.mjs's own doc comment for the
// full transport inventory this is based on, and for why `net`/`tls` (the actual local Postgres wire
// protocol transport) are deliberately never touched. Credentials are cleared BEFORE this guard is
// installed and before any test module below can import a real sender factory, so neither a leaked
// credential nor a leaked module-level cached client can matter even in principle.
clearNotificationCredentials();
installDefaultDenyOutboundGuard();

process.env.AUDIT_HASH_SECRET ??= "test-only-audit-hash-secret-value";
process.env.AUTH_PASSWORD_PEPPER ??= "test-only-auth-password-pepper-value";
process.env.APP_ENV ??= "test";
