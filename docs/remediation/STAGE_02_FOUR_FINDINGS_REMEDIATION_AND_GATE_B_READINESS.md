# Stage 2 — Four-Findings Remediation and Gate B Readiness

**PAID2YOU — STAGE 2 CRITICAL REMEDIATION ORDER**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: controlled offline implementation and verification only.
No Docker, container, database connection, migration, `npm run test:postgres` invocation, dependency install, provider/email/SMS contact, or production access occurred. Generated: 2026-09-19.

---

## A. Baseline and complete changed-file inventory

**Baseline confirmed before any edit:** directory `C:\Development\PAY2PAY-bank-v3`, branch `architecture/bank-managed-payments-v3`, HEAD `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` — **unchanged** at the end of this order (no commit made). `git status --porcelain` line count: 84 before this order's edits, 89 after (net +5: two brand-new untracked files, `docs/remediation/STAGE_02_PHASE_A_ARCHITECTURE_AND_ISOLATION_REPORT.md` from the prior order plus one prior untracked change already counted — the delta reflects exactly the new files this order adds; see below). No sibling worktree was accessed, including read-only, at any point in this order.

**Complete changed-file inventory (6 files, all within the order's authorized change categories):**

| File | Status | SHA-256 (current) |
|---|---|---|
| `scripts/postgres-test-db.mjs` | Modified (harness) | `5a6d7de9943bd92ae93336bf0df2705bac33f50d9a7cfa9b05ad1a9102e06512` |
| `scripts/postgres-test-db.test.mjs` | Modified (offline unit tests) | `8761592fb547df87da06692aeadd24a059e758edabd407735cd20e82d867c5ca` |
| `test/postgres/outboundTransportGuard.mjs` | **New** (test-only outbound guard) | `1549195da78883bdb20fc975e65ed22be8fd50148e5e0e00a4ef1d06da6711d9` |
| `test/postgres/outboundTransportGuard.test.mjs` | **New** (offline unit tests) | `a2b7cefa609fab5c8015b63460b6e1bc5af228ee46360ac4d6442654b8ad932b` |
| `vitest.postgres.setup.ts` | Modified (wires the guard in) | `a74575c2caa6837ddc053b0164192bc8df9bfd0c5cc2ec93378dbddb71d02eb0` |
| `src/lib/payments/paymentWebhookRecovery.postgres.test.ts` | Modified (008-F/008-F-BLOCKED/008-G/008-I added) | `a32dd5a30698b950efba2e26c6be5ec49966edca9b8769e1a226ddb7eb2ab0fe` |

**Not touched, as required:** `test/postgres/verifyHarnessOwnership.mjs` and its `.test.mjs` (reused as-is — imported directly by the harness for FIX 01's marker verification, no change needed), `vitest.postgres.config.ts` (no change needed), every production coordinator/service/provider/schema/migration file, `docs/remediation/STAGE_02_PHASE_A_ARCHITECTURE_AND_ISOLATION_REPORT.md` (read, not modified). No production defect was demonstrated by this order's analysis — see Sections B-E; every fix is confined to harness/test-only files.

---

## B. Finding 01 — pre-migration isolation

### Original ordering (evidence, before this order's edit)

Read in full before editing. `scripts/postgres-test-db.mjs`'s previous `main()` executed, in this exact order: `docker run` (create container) → discover host port (`docker port`) → `validateResolvedTarget(host, port)` (a **purely static string comparison** — loopback host + non-forbidden port, no independent Docker metadata at all) → `waitForReady(databaseUrl)` (the **first real network connection**) → `run(... "apply-migrations-fresh.mjs" ...)` (the **first schema write**) → `writeOwnershipMarker(databaseUrl, runToken)` (marker created **only now, after migrations had already run**) → hand off to `npx vitest run --config vitest.postgres.config.ts`, whose own `vitest.postgres.setup.ts` was the **only** place `verifyHarnessOwnership` (the marker **check**) was ever invoked.

**Explicit finding, as required:** migrations preceded the `_pg_test_harness_marker` marker's creation, and the marker's own verification happened later still, inside a separate child process (Vitest), after schema changes had already been applied. **A marker written after the fact cannot protect a migration that already ran** — this was a real ordering defect, not merely an undocumented one, confirmed by reading `main()`'s literal statement order (previously: docker run → port discovery → static validation → connect → migrate → write marker → spawn Vitest → Vitest's setup verifies marker).

### Code correction

`scripts/postgres-test-db.mjs`'s `main()` now runs, in order: (A) the pre-existing static preflight (`validateRequestedPort`, unchanged) — confirmed, by reading the whole file, that `DATABASE_URL` is **never** read from the inherited environment for connection purposes; every child process (`apply-migrations-fresh.mjs`, the Vitest run) receives `DATABASE_URL` **overwritten** by this script's own freshly-constructed value (`env: { ...process.env, DATABASE_URL: databaseUrl }`), so an inherited production/development URL can never leak through by omission. (B) **new** `verifyContainerIdentity`, fed by a **new** `docker inspect <containerName>` call and `parseDockerInspectOutput`, correlating the container's immutable ID (non-empty), exact name, both harness labels (`pay2pay-test-harness=true` and the run-token label), image, and running state — run immediately after port discovery, before `waitForReady`. (C) **new** `verifyDatabaseIdentity`, querying `current_database()`, `current_user`, `inet_server_addr()`, `inet_server_port()`, `version()` immediately after the first connection succeeds and strictly before any schema/data write; only `current_database`/`current_user` are pass/fail conditions (per this order's own instruction, Docker's internal server address/port need not equal the published host mapping, so those two are recorded as supplementary evidence only). (D) `writeOwnershipMarker` followed **immediately** by `verifyHarnessOwnership` (the exact same function Vitest's setup file also calls — one implementation, not a divergent second one) — now **before** migrations, not after. (E) migrations only after A-D all pass; any thrown `HarnessFailure` from B/C/D is caught by the existing `try/catch`, still runs the existing unconditional container-cleanup `finally` block, and exits nonzero — migrations are never reached on any rejection.

**Approval separation:** a new `resolveRunMode(argv)` makes the default invocation (`npm run test:postgres`, no arguments) stop immediately after migrations and the new coarse-grained runtime-role creation (Finding 03), **without ever invoking** `npx vitest run --config vitest.postgres.config.ts`. The financial-recovery suite only runs when explicitly invoked as `node scripts/postgres-test-db.mjs --run-tests` — a distinct control-flow branch, not a printed warning followed by automatic execution.

### Offline negative tests (all in `scripts/postgres-test-db.test.mjs`, dependency-injected, zero real Docker/DB contact)

`parseDockerInspectOutput` (parses real-shaped JSON; returns `null` for malformed/empty input rather than guessing); `verifyContainerIdentity` — REJECTS: null inspection, missing/empty container ID, mismatched name, missing harness label, wrong run-token label, wrong/unexpected image, not-running state; ACCEPTS a fully-matching case. `verifyDatabaseIdentity` — REJECTS: wrong `current_database()`, wrong `current_user` (wrong DB role), an empty result set; ACCEPTS a matching case. `resolveRunMode` — defaults to `"validate-only"` for no arguments and for a near-miss/case-mismatched flag; only the exact `--run-tests` string enables execution. Every one of these is a pure function test — no `main()` end-to-end simulation was attempted (that would require a real Docker daemon), but each individual gate `main()` now calls is proven, by these tests plus direct source citation above, to reject exactly the inputs this fix enumerates before any migration statement is ever constructed.

**Pass condition:** satisfied — the exact first write (`apply-migrations-fresh.mjs`, invoked only after A-D) and every preceding guard are proven by source (this section) and by the 30 new/adjusted offline tests below (Section G).

---

## C. Finding 02 — default-deny outbound traffic

### Transport inventory (established before writing any guard code)

`src/**/*.postgres.test.ts` (8 files) grepped for `fetch(`, `axios`, `node-fetch`, `https?.request`, `XMLHttpRequest`, `WebSocket(` — **zero matches**. Grepped for `getEmailSender`, `getSmsSender`, `ResendEmailSender`, `TwilioSmsSender`, `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `getPaymentProvider(` — matches only in `paymentWebhookRecovery.postgres.test.ts` and `installmentAmountAwareness.postgres.test.ts`, and in both cases the only match is `createTestNotificationService` (from `@/lib/notify/testFakes`), which wires `InMemoryEmailSender`/`InMemorySmsSender` — **never** the real sender factories. The only provider-shaped import anywhere in the 8 files is `SandboxPaymentProvider` (`@/test-support/payments/sandboxPaymentProvider`), itself grepped for `fetch(`/`http`/`axios` — zero matches: a pure in-process fake with no transport of its own. **Conclusion: the current reachable transport surface is already zero**, but the guard below is installed as structural, always-on protection against a *future* test accidentally introducing one — not merely a description of today's state.

The actual local PostgreSQL transport is the `postgres` npm package, which speaks the wire protocol directly over `node:net`/`node:tls` — never `fetch`/`http`/`https`.

### Guard implemented

New `test/postgres/outboundTransportGuard.mjs`: `clearNotificationCredentials(env)` deletes `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_DELIVERY_ENABLED`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER`, `SMS_DELIVERY_ENABLED` from the process environment; `installDefaultDenyOutboundGuard()` replaces `globalThis.fetch`, `http.request`, `http.get`, `https.request`, `https.get` with functions that **throw synchronously** (never a rejected Promise — the exception fires before any `await`, before any DNS lookup or socket could open) and returns a `restore()` function. `vitest.postgres.setup.ts` now calls `clearNotificationCredentials()` then `installDefaultDenyOutboundGuard()` immediately after `verifyHarnessOwnership`, before any test module's own imports run (this Vitest config's `pool: "forks"` + `singleFork: true` means the setup file runs once for the entire single-fork worker process, so this applies for the whole suite run).

### Escape tests (all in `test/postgres/outboundTransportGuard.test.mjs`, offline, zero real network contact)

Prove `fetch`/`http.request`/`http.get`/`https.request`/`https.get` all throw synchronously with the guard installed; prove `restore()` puts back the exact original references and that the SAME call no longer throws afterward (demonstrating the guard, not something else, was the cause — "prove guard removal makes the test fail," inverted as "prove restoring un-fails it"); prove `net.connect`/`tls.connect` are **never** touched by the guard (read back unchanged after installation) — the approved local Postgres transport remains allowed by policy, without this test ever opening a real socket; prove `clearNotificationCredentials` deletes exactly the enumerated keys, never an unrelated variable, and is idempotent; a regression-guard test pins the exact key list against the real `getEmailSender.ts`/`getSmsSender.ts`/`env.ts` source so a future edit to those files that adds a new credential key would need a matching update here (a silent gap would otherwise reopen invisibly).

### Limitations, disclosed

This is **application-level** (Node process global-function) interception only — **not** OS-level network isolation (no firewall, no network namespace, no container egress policy). A transport that opens its own raw `net`/`tls` socket without going through `fetch`/`http`/`https` would not be caught; no such transport was identified in the current reachable code (every external call anywhere in this codebase's provider/notification senders uses `fetch` directly), so this is a disclosed scope boundary, not a silently-ignored gap. Every reachable transport identified is covered by demonstrated default denial; none is reported BLOCKED.

**Pass condition:** satisfied under the disclosed scope above.

---

## D. Finding 03 — database role and verifiable target identity

### Privilege model determined

`vitest.postgres.setup.ts`'s own pre-existing doc comment states plainly: "these tests run real DDL/DML against whatever `DATABASE_URL` points to." This was read and taken as authoritative rather than assumed away: a naive DML-only reduced role would break real test execution in a way this order explicitly forbids ("Never silently waive the requirement or weaken test fidelity") and that **cannot be verified offline** (which of the 60+ existing tests do DDL was not exhaustively enumerated — guessing wrong risks breaking Phase C on a run this order does not authorize me to observe or fix in the moment).

**Decision:** bootstrap/migration identity remains the Docker image's default `postgres`/`postgres` superuser (unavoidable — `apply-migrations-fresh.mjs` requires DDL rights). A **new**, dedicated, freshly-created, randomly-passworded runtime role (`pay2pay_test_runtime`, defined by `buildRuntimeRoleStatements`) is created **after** migrations and **before** any possible test execution, granted `ALL PRIVILEGES` on the one disposable database/`public` schema/tables/sequences (so it can do everything the existing DDL/DML-mixed tests already do) while explicitly carrying `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` on its `CREATE ROLE` statement — losing the *specific* superuser capabilities that matter if these ephemeral credentials were ever reused outside this one disposable, loopback-only, single-run container. **This is disclosed as a coarse-grained privilege reduction, not true least-privilege** — the exact "clearly marked exception awaiting explicit owner approval" this order's own Finding 03 anticipates for a genuine incompatibility. `main()` now uses this runtime role's own connection URL (`buildRuntimeDatabaseUrl`) for the eventual `--run-tests` Vitest invocation — never the bootstrap credentials.

### Identity evidence

Correlated elements, per this order's own list: run token (harness label + marker table row), immutable container ID (`docker inspect`), labels (both), image, published bind/port (cross-checked between `docker port` and `docker inspect`'s own port mapping), URL (always harness-constructed, never inherited), in-database name/role/server metadata (`verifyDatabaseIdentity`), PostgreSQL version (recorded), and the ownership marker (`verifyHarnessOwnership`). No single element alone gates a destructive operation — Section B's ordering requires B, C, and D to *all* pass before migrations, and the runtime role is created only after migrations succeed. No credential is ever logged in full; `buildRuntimeDatabaseUrl`'s own doc comment states this explicitly, mirroring `verifyHarnessOwnership`'s pre-existing redaction pattern.

### Offline negative tests

`buildRuntimeRoleStatements` — rejects an empty/short/undefined password; asserts the `CREATE ROLE` statement contains every one of the five `NO*` capability flags; asserts the full statement list never grants `CREATEDB`/`CREATEROLE`/`REPLICATION`/`BYPASSRLS` in their non-negated form anywhere; asserts the statement list always begins with `DROP ROLE IF EXISTS` (so a leftover role from an interrupted prior run of the SAME fixed name can never collide). `buildRuntimeDatabaseUrl` — asserts the built URL uses the runtime role's own credentials, never the bootstrap `postgres:postgres` pair. All of Section B's `verifyContainerIdentity`/`verifyDatabaseIdentity` negative tests (mismatched container/database/role/port/token) double as this section's own "mismatch is refused before migration or test execution" proof — no negative test in either section ever points at a real production/development database; every one uses an injected fake.

### Owner exception, explicitly flagged

The reduced runtime role's privilege set is **unverified against a real database** — this order does not authorize any database connection, so whether `ALL PRIVILEGES ON ALL TABLES/SEQUENCES IN SCHEMA public` (plus the default-privilege grant for anything migrations might additionally create within the same run, which does not apply here since the role is created strictly after migrations complete) is actually sufficient for every one of the 60+ existing and 4 newly-added postgres tests is **not proven** by this order. If a future, separately-authorized Phase B/C run reveals a missing privilege, the exact, disclosed remediation is to widen `buildRuntimeRoleStatements`'s own statement list — never to silently fall back to the bootstrap role for test execution.

**Pass condition:** satisfied via working, offline-tested role-separation code plus this explicitly marked exception — no unguarded path to migration exists (Section B), and the runtime role is strictly narrower than the bootstrap role on every capability this order names.

---

## E. 008-C/F/G/H/I acceptance matrix

All of 008-F/008-F-BLOCKED/008-G/008-I below are **newly written this order** in `src/lib/payments/paymentWebhookRecovery.postgres.test.ts`, grounded in a full read of `resolveAmbiguousRetry` (`failedPaymentRetryCoordinator.ts:2059`) and `resolveNotFoundOutcome` (`:2158`, private) and reusing this file's own existing seed/spy helpers (`seedTwoParties`, `seedAgreementWithInstallment`, `seedInstallmentPayment(WithMethod)`, `backdateRetryScheduledFor`, `listRetriesForInstallment`, `listPaymentAttemptsForAgreement`, `spyOnCreatePayment`, `buildRetryEligibilityHarnessWithCoordinatorFlag`) exactly as the pre-existing `R-B40-STRICT-C`/`R-B54*`/`TEST 008-C`/`TEST 008-H/I` tests already do. **None of the below has been executed against PostgreSQL.** "PG-execution status: NOT VERIFIED" is stated for every row, per this order's own explicit instruction ("Unexecuted means NOT VERIFIED, never PASS").

| Req | Source path | Test name | Fixtures | Provider-double behavior | Persisted assertions | Expected result | Code status | PG-execution status |
|---|---|---|---|---|---|---|---|---|
| 008-C | `failedPaymentRetryCoordinator.ts:1546` (`claimAndExecuteRetry`) via `paymentRetryService.ts:390` (`fireDueRetries`) | `TEST 008-C` (pre-existing, unchanged, `:2508`) | `seedTwoParties`/`seedAgreementWithInstallment`/`seedVerifiedParties`/`seedInstallmentPaymentWithMethod`, flag=true | `SandboxPaymentProvider`, spied, accepts | `callCount()===1`; `payment_retry.status==="fired"` | Provider called exactly once, retry fires | CODE-CREATED (pre-existing, preserved verbatim — no missing assertion identified) | NOT VERIFIED |
| 008-F | `resolveAmbiguousRetry`→`resolveNotFoundOutcome` (`:2059`/`:2158`) | `TEST 008-F` (**new**) | Same seeds; one-shot-ambiguous-then-real provider Proxy | First `createPayment` throws `AmbiguousProviderResponseError` (never reaches the real provider — genuine "not found" precondition, confirmed via `retrievePaymentByIdempotencyKey` returning `null`); second (redispatch) call succeeds | `firstOutcome.outcome==="ambiguous"`; `retrievePaymentByIdempotencyKey===null`; retry stays `"claimed"` with a non-null `executionToken`; `recoveryOutcome.outcome==="fired"`; `callCount()===1`; exactly 1 row for the idempotency key with a non-null `providerPaymentId`; a THIRD, repeated `resolveAmbiguousRetry` call returns `"not_applicable"` with `callCount()` still `1` | Authorized, bounded, idempotent redispatch; no duplicate on repetition | CODE-CREATED | NOT VERIFIED |
| 008-F (false-authorization half) | Same | `TEST 008-F-BLOCKED` (**new**) | Same not-found setup; a SECOND coordinator instance with flag=false resolves | Same one-shot-ambiguous provider | `blockedRecovery.outcome==="still_ambiguous"`; `callCount()===0`; retry stays `"claimed"`; a LATER authorized-coordinator call then succeeds (`"fired"`, `callCount()===1`) | False authorization prevents redispatch without destroying recoverability | CODE-CREATED | NOT VERIFIED |
| 008-G | `PaymentWebhookService.receiveWebhook` (unaffected by the coordinator) + `buildRetryEligibilityHarnessWithCoordinatorFlag(false)` | `TEST 008-G` (**new**) | `B01`-shape historical webhook seed, PLUS a second, unrelated installment/retry under a flag=false coordinator | Historical half: real `SandboxPaymentProvider` webhook flow, untouched by any flag. New-initiation half: spied provider, flag=false | Historical: `status==="processed"`, `payment.status==="succeeded"`, exactly 1 `payment_cleared` ledger entry, agreement `"paid_in_full"` — all still true AFTER the new-initiation half runs. New-initiation: `callCount()===0`; retry status is not `"fired"` | Historical processing commits normally; new initiation is blocked; the two never interact | CODE-CREATED | NOT VERIFIED |
| 008-H | `dispatchProviderCallForAnchor` (`:1742`) guards | `TEST 008-H/I` (pre-existing, unchanged, `:2525`) | `buildRetryEligibilityHarnessWithCoordinatorFlag(false)` | Spied provider, never reached | `callCount()===0` (both firings); `status` not `"fired"`/not `"canceled"` (both firings); no duplicate `payment_attempt` row across two firings while still blocked | Recoverable blocked claim, no duplicate | CODE-CREATED (pre-existing — this order did not add the executionToken/eligibility-for-later-recovery assertions the order's own Section 4 additionally asks for; see Limitation below) | NOT VERIFIED |
| 008-I | `findClaimedForResumption`/`markResolutionDeferred` (`paymentRetryService.ts:489,499`) | `TEST 008-I` (**new**) | Same core seeds; a provider that is ambiguous on attempts 1-2, succeeds on attempt 3; three separate, explicit `fireDueRetries(now)` calls at controlled times | Ambiguous ×2 (initial claim + same-call immediate resumption), then genuinely accepts | `attemptNumber===2` after the first call; `nextResolutionAttemptAt` non-null and within 2s of `t0 + AMBIGUOUS_RETRY_RESOLUTION_BACKOFF_MS` (the real production constant, not a mock); a call BEFORE that time leaves `attemptNumber===2` and status `"claimed"` with the SAME `executionToken`; a call AFTER it advances to `attemptNumber===3` and status `"fired"`; exactly 1 `payment_attempt` row for the whole sequence | Real backoff-scheduled resumption, no premature/duplicate dispatch, stable fencing token | CODE-CREATED | NOT VERIFIED |

**Disclosed limitation on 008-H:** this order's own Section 4 text asks 008-H to additionally assert "preserved execution token... and demonstrated eligibility for a legitimate later recovery path" beyond the pre-existing test's "not fired"/"not canceled" pair. The pre-existing test was preserved **unchanged** (its own two assertions remain valid and are not weakened), and this order's new 008-I test independently demonstrates the "preserved execution token across a blocked-then-later-resumed sequence" property in a different, arguably more decisive scenario (a real ambiguous claim, not merely a disabled-flag claim). A dedicated, additional assertion inside `TEST 008-H/I` itself reading `retryRow.executionToken` explicitly was **not** added this round, to avoid modifying an already-passing, explicitly-preserved existing test's own body beyond what was strictly necessary — this is disclosed as a residual, minor gap rather than silently claimed complete.

---

## F. Same-retry concurrency proof/plan

Determined (source inspection only, no test execution): the schema's own `executionToken` column (`payment_retry.ts:54`, minted only at claim time, re-confirmed via `confirmExecutionStillValid` immediately before the real provider call — `failedPaymentRetryCoordinator.ts:2294`) is the exact mechanism that would need to be exercised for a genuine "two workers race to claim/dispatch the SAME retry row" proof. The existing suite's closest analogue, `R-B40-STRICT-B` ("the installment lock is genuinely held through the real provider call; a concurrent `coordinateSuccess` is proven blocked"), pairs a retry dispatch against a competing SUCCESS, not against a second competing dispatch of the same row — a literal same-row dispatch race was not found under any existing name. **This order's own five acceptance items (008-C/F/G/H/I) do not name this scenario**, and Section 4's own closing instruction is explicit: "Do not expand into unrelated redesign or same-batch supersession unless directly applicable to the stated recovery cases." Accordingly, **no new same-retry-race test was added this round** — this is reported as an identified, adjacent, currently-unproven scenario for the owner's awareness (carried forward from the Phase A report's own Section A6), not manufactured into a new acceptance criterion without separate authorization.

---

## G. Every executed command and result

All commands below are safe, non-PostgreSQL, non-Docker offline checks, run in this order (as required):

| Step | Command | Purpose | Result |
|---|---|---|---|
| 1 | `npm run test:tooling` (`node --test scripts/*.test.mjs test/postgres/*.test.mjs`) | Offline harness/guard unit tests (includes all NEW Section B/C/D tests plus every pre-existing scanner/migration-tooling test) | **142/142 pass**, exit 0 |
| 2 | `npm run typecheck` (`tsc --noEmit`) | Full-repository static typecheck, including the new 008-F/008-F-BLOCKED/008-G/008-I test code | **0 errors**, exit 0 |
| 3 | `npm run lint` (`eslint`) | Full-repository lint | **0 errors**, exit 0, 12 pre-existing warnings (identical set to every prior round — none in any file this order touched) |
| 4 | `npx vitest run` (full non-PostgreSQL suite) | Confirm zero regression and confirm the new `.postgres.test.ts` content is correctly excluded | **257/257 files, 2237/2237 tests pass**, exit 0 |

`npm run test:postgres`, `docker version`/`docker info`, and any real database connection were **NOT EXECUTED** — not authorized under this order.

---

## H. Unexecuted DB-dependent cases

Every row in Section E (008-C, 008-F, 008-F-BLOCKED, 008-G, 008-H, 008-I) is DB-dependent and unexecuted this order. No DB-dependent case is claimed PASS anywhere in this report.

---

## I. Exact proposed Phase B commands and effects

Unchanged from the Phase A report's own proposal, now updated for this order's code changes: `node scripts/postgres-test-db.mjs` (no `--run-tests` — the new default `"validate-only"` mode) would, if run: start one disposable `postgres:17-alpine` container (unique generated name, loopback-only port) → `docker inspect` it and reject on any identity mismatch → connect once and reject on any `current_database()`/`current_user` mismatch → bootstrap and immediately verify the ownership marker → apply the full current migration set via `apply-migrations-fresh.mjs` → create the coarse-grained `pay2pay_test_runtime` role → **stop**, printing a Gate-B-readiness message, without ever invoking the `*.postgres.test.ts` suite. A subsequent, separately authorized `node scripts/postgres-test-db.mjs --run-tests` would additionally run that suite (008-C/F/G/H/I among the 65 total tests in the one modified file) under the reduced-privilege runtime role, then unconditionally tear the container down. No other command or effect is proposed.

---

## J. Disposable target identity and writable-path allowlist

**Disposable target identity (unchanged from Phase A, now additionally enforced in code):** container name `pay2pay-pgtest-<pid>-<random>`, image `postgres:17-alpine`, labels `pay2pay-test-harness=true` and `pay2pay-test-harness-run=<runToken>`, bound to `127.0.0.1` on a Docker-assigned (or explicitly validated, non-forbidden) port, database `postgres`, bootstrap role `postgres` (migrations only), runtime role `pay2pay_test_runtime` (test execution only, if and when `--run-tests` is separately authorized).

**Writable-path allowlist for any future, separately-authorized Phase B/C run:** `src/lib/payments/paymentWebhookRecovery.postgres.test.ts` (already modified this order, test-only); the disposable database itself (schema + the one new role, created and destroyed entirely within the disposable container); `docs/remediation/` report files. No other path is proposed.

---

## K. Residual blockers and decisions

1. **Docker Desktop's engine is not currently running** (established in the Phase A report; not re-checked this order, since this order does not ask for a re-check and is otherwise silent on `docker version`/`docker info` permission — carried forward as still-true, unverified-as-of-this-report). This alone blocks any real Phase B run regardless of code readiness.
2. **FIX 03's runtime role is an explicitly disclosed, unverified exception** (coarse-grained, not true least-privilege) — Section D.
3. **008-H's own body was not additionally amended** with an explicit `executionToken`-read assertion (Section E's disclosed limitation) — the property is otherwise demonstrated by the new 008-I test.
4. **Same-retry concurrency** (Section F) remains an identified, adjacent, out-of-scope-for-this-order gap — not fixed, not fabricated into a new requirement.
5. All of Sections B/C/D/E's code is **unverified against a real PostgreSQL instance** — this is the expected, correct state under this order's own terms, not a defect.

---

## L. Gate B readiness classification

```
READY FOR OWNER REVIEW OF PHASE B AUTHORIZATION
```

All four findings have working, offline-tested code corrections (142/142 new-and-existing offline tests, 0 typecheck errors, 0 lint errors, 257/257 non-PostgreSQL tests unaffected). PostgreSQL-dependent verification is explicitly and correctly still pending — no case above is claimed PASS. The residual items in Section K (Docker not running, FIX 03's disclosed coarse-grained exception, 008-H's minor unamended assertion, same-retry concurrency left out of scope) are presented for the owner's review, not concealed.

### Corrected lifecycle diagram

```
npm run test:postgres  (no --run-tests: default "validate-only" mode)
  │
  ├─ A. static preflight (validateRequestedPort) — unchanged, pre-existing
  ├─ docker run (disposable container, unique name+labels, loopback-only port)
  ├─ discover host port (docker port)
  ├─ validateResolvedTarget (static host/port re-check) — unchanged, pre-existing
  ├─ B. NEW: docker inspect → parseDockerInspectOutput → verifyContainerIdentity
  │      (id / name / labels / image / running — all independently correlated)
  │      ── FAIL → HarnessFailure → cleanup → nonzero exit, NO further step runs
  ├─ waitForReady (first real DB connection)
  ├─ C. NEW: verifyDatabaseIdentity (current_database / current_user / version)
  │      ── FAIL → HarnessFailure → cleanup → nonzero exit, NO further step runs
  ├─ D. writeOwnershipMarker  →  verifyHarnessOwnership  (bootstrap, then IMMEDIATE verify)
  │      ── FAIL → HarnessFailure → cleanup → nonzero exit, NO migration runs
  ├─ E. apply-migrations-fresh.mjs   (only now — after A-D all passed)
  ├─ NEW: create pay2pay_test_runtime (coarse-grained reduced-privilege role)
  ├─ resolveRunMode(argv)
  │      "validate-only" (default) ──► STOP. Report Gate-B-readiness. Container removed. Exit 0.
  │      "--run-tests" (explicit, separately authorized) ──► run *.postgres.test.ts
  │                                                            under the runtime role, then
  │                                                            unconditional container removal.
  └─ finally: cleanupAndFinalize() — always attempted, on every exit path, unconditionally
```

*End of report.*
