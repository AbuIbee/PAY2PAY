import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * R07 (DB integrity & concurrency hardening): a separate Vitest project for the
 * `*.postgres.test.ts` integration/concurrency suites — these require a real, disposable Postgres
 * database (see scripts/postgres-test-db.mjs, which is what `npm run test:postgres` runs) and are
 * deliberately excluded from the ordinary `vitest.config.ts` run (see that file's own `exclude`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Same rationale as vitest.config.ts's identical alias — see test/stubs/server-only.ts.
      "server-only": path.resolve(__dirname, "./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    // STAGE 2 REPORTER-ONLY CORRECTION (docs/remediation/STAGE_02_REPORTER_ONLY_CONFIGURATION_CHANGE.md):
    // no reporter was previously configured (Vitest's own unnamed default), which only shows an
    // aggregate pass/fail summary per file, not each named test. The built-in "verbose" reporter
    // (supported by the installed vitest@^3.2.6) prints every individual test's own name and
    // pass/fail status — needed to see TEST 008-C/F/F-BLOCKED/G/H-I/I and R-B51 individually in the
    // suite's own output, not merely the file-level aggregate.
    reporters: ["verbose"],
    setupFiles: ["./vitest.postgres.setup.ts"],
    include: ["src/**/*.postgres.test.ts"],
    css: false,
    // These suites deliberately exercise real locking/concurrency races against one shared
    // disposable database (and R04's single global audit chain in particular has no natural way to
    // run in isolation per file) — running test files in parallel would make different suites'
    // races interfere with each other and produce flaky, undiagnosable failures. A single worker,
    // one file at a time, keeps every race deterministic and attributable to the file that caused it.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Some suites loop several real-connection race iterations per test (proving both possible
    // race outcomes empirically, since Postgres does not expose a way to force a specific one) —
    // generous but bounded, so a genuine hang still fails loudly rather than blocking CI forever.
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
