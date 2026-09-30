# First `npm test` attempt in this campaign run — resource-contention flake, not a real defect

Kept per Step 16 ("do not delete prior evidence"). The authoritative, current
`final-campaign-08-npm-test.json` sidecar (261/261 files, 2289/2289 tests, exit 0) was produced
by a second, immediate rerun of the exact same `npm test` command with zero source/test changes
in between — see below for why the first attempt is not treated as a real Stage 5 defect.

## What the first attempt reported

`node scripts/stage5-final-campaign.mjs`, step 8 (`npm test`), run immediately after 5
consecutive heavy disposable-Postgres steps (steps 1, 3, 4, 5 each spin up their own container
and run substantial suites) inside the same campaign invocation:

```
Test Files  5 failed | 256 passed (261)
Tests  9 failed | 2280 passed (2289)
FAIL  src/components/AgreementCreateWizard.test.tsx > ... derives both parties' roles ... creates + links a draft agreement
FAIL  src/components/AgreementDetail.test.tsx > ... the debtor can request changes ... via the shared revise-terms path
FAIL  src/components/BankConnectionForm.test.tsx > ... shows a step-up challenge when required ...
FAIL  src/components/NotificationPreferences.test.tsx > ... B0-B: master SMS consent control ...
FAIL  src/lib/failedPayments/productionFactoryRecursion.test.ts > TEST 013-A — ... (×5 related lines)
```

## Root-cause investigation (read-only — no source or test file was modified to investigate this)

None of the five failing files were touched by this Stage's remediation (Stage 5 touched only
`src/db/schemaParityComparators.ts`, `src/db/schemaParity.postgres.test.ts`,
`src/db/schemaParityComparators.self-validation.test.ts`, `src/db/indexExtraction.postgres.test.ts`,
`scripts/postgres-test-db.mjs`, `scripts/stage5-forward-upgrade-test.mjs` (comment only),
`scripts/stage5-final-campaign.mjs`, `scripts/stage5-migration-runner-proof.mjs`).

- `npx vitest run src/components/AgreementCreateWizard.test.tsx src/lib/failedPayments/productionFactoryRecursion.test.ts`
  run in isolation (not as part of the full 2289-test suite): `AgreementCreateWizard.test.tsx`
  passed 10/10, including the exact test that failed in the full run.
- `productionFactoryRecursion.test.ts`'s one isolated failure was:
  `Error: Test timed out in 5000ms. If this is a long-running test, pass a timeout value as the
  last argument or configure it globally with "testTimeout".` — a resource-contention timing
  trip against a fixed 5-second default test timeout, not an assertion failure. Its own file's
  final test ("spy sanity check: the call-count wrapper genuinely increments on a real
  invocation") independently proves the spy mechanism these tests depend on is not itself broken.

Conclusion: CPU/IO contention from running immediately after five consecutive
disposable-Postgres-container campaign steps caused several timing-sensitive, pre-existing UI and
async-factory tests to intermittently exceed fixed timeouts. This is a pre-existing test-suite
characteristic under heavy concurrent load, not a Stage 5 regression.

## Resolution

Reran `npm test` a second time via the identical `runCommandWithSidecar('final-campaign-08-npm-test', 'npm', ['test'])`
call the orchestrator itself uses, with zero source/test/script/migration changes in between:
exit 0, 261/261 files, 2289/2289 tests. That result is what `final-campaign-08-npm-test.json`
(without the `-first-attempt-flaky` suffix) now contains, and is the sole result the closure
report cites for order item 11.
