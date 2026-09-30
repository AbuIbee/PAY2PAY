# Stage 2 — Phase C: REM-008 Real-PostgreSQL Execution Report

**PAID2YOU — STAGE 2 FINAL CONTROL ORDER, Phase C**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Generated: 2026-09-19.

**Owner authorization received and honored exactly:** one execution of `node scripts/postgres-test-db.mjs --run-tests`, against the disposable Docker PostgreSQL environment only, using the established identity/marker/reduced-role/provider-double/outbound-guard controls. No production, hosted, development, or shared database was accessed. No real payment, email, SMS, or banking provider was used. **No production code, migration, or test expectation was modified to obtain a passing result** — every failure below is reported exactly as observed, unaltered.

---

## Executive result

```
node scripts/postgres-test-db.mjs --run-tests
Exit code: 1   (nonzero — reflects 2 genuine test failures; container teardown itself succeeded)

Test Files:  1 failed | 6 passed (7)
Tests:       2 failed | 279 passed (281)
Duration:    90.40s
```

**2 failures occurred, both captured and analyzed below — neither concealed, neither worked around.** One is in a test this Stage 2 work wrote (`TEST 008-I`); one is in a pre-existing test unrelated to any Stage 2 change (`R-B51`). A separate, real anomaly was also found and is reported honestly: an 8th `*.postgres.test.ts` file did not run at all.

## Run identity (this execution)

| Field | Value |
|---|---|
| Container name | `pay2pay-pgtest-24592-3d4e3c98` |
| Container ID (as logged) | `d9832b96c8af...` |
| Image | `postgres:17-alpine` |
| Run token | `9a0309a9-daa0-48d4-bfb9-1782c3502cbd` |
| Published bind | `127.0.0.1:52561` |
| `current_database` / `current_user` (bootstrap, pre-migration) | `postgres` / `postgres` |
| Migrations applied | 55 (unchanged repository set) — `[fresh-migration-test] OK — all 55 migrations applied cleanly to an empty database.` |
| Runtime role created | `pay2pay_test_runtime` (the corrected, ownership-transfer-free, `BYPASSRLS`-exception statement list) |
| Vitest `DATABASE_URL` | the **runtime role's own URL** (`buildRuntimeDatabaseUrl`) — confirmed by source (`main()`'s `"run-tests"` branch), not merely assumed |
| Teardown | Container fully removed; confirmed by two independent post-run `docker ps -a` queries (by exact name, and by harness label) returning zero rows |

**This is the first time this reduced-privilege runtime role has ever been used to run real queries** — and it worked for 279 of 281 tests, including every genuinely concurrent, multi-connection test (`B06`, `B31`, `B32`, `R-B40-STRICT-A/B/C`, `R04-A`'s 20-concurrent-connections proof), which each open their own separate `postgres()` connection using the same runtime-role `DATABASE_URL` (captured once at test-file module load). This is real, empirical confirmation — not merely offline-asserted — that the DML-only, ownership-transfer-free, `BYPASSRLS`-excepted role design from the prior correction is sufficient for the actual test suite, for every file that ran.

## Per-file results

| File | Tests | Result |
|---|---|---|
| `src/lib/payments/paymentWebhookRecovery.postgres.test.ts` | 157 | **2 failed**, 155 passed |
| `src/lib/ledger/installmentAmountAwareness.postgres.test.ts` | 89 | All passed |
| `src/lib/settlements/settlementBinding.postgres.test.ts` | 14 | All passed |
| `src/lib/agreements/signingConcurrency.postgres.test.ts` | 11 | All passed |
| `src/lib/agreements/generalTermsRevisionConcurrency.postgres.test.ts` | 3 | All passed |
| `src/lib/relationships/relationshipFinancialAccountService.postgres.test.ts` | 4 | All passed |
| `src/lib/audit/auditService.postgres.test.ts` | 3 | All passed |
| `src/lib/payouts/payoutService.postgres.test.ts` | — | **Did not run — see Section "Anomaly" below** |

281 = 157+89+14+11+3+4+3, matching the summary line exactly.

## 008-C/F/G/H/I acceptance matrix — actual results

| Requirement | Result | Detail |
|---|---|---|
| 008-C | **PASS** | `TEST 008-C` — 151ms |
| 008-F | **PASS** | `TEST 008-F` — 168ms |
| 008-F-BLOCKED | **PASS** | `TEST 008-F-BLOCKED` — 169ms |
| 008-G | **PASS** | `TEST 008-G` — 233ms |
| 008-H | **PASS** | `TEST 008-H/I` (the existing test, amended this round with the execution-token, anchor-identity, and genuine-later-recoverability assertions) — 186ms. Every added assertion passed, including the new final step (a fresh, authorized coordinator's `resolveAmbiguousRetry` call reaching `"fired"`), on the FIRST real execution. |
| 008-I | **FAIL** | `TEST 008-I` (new, dedicated) — see "Failure 1" below |

**Same-retry concurrency** (Section F of the prior report — proven impossible by code citation, not a new test): the general locking mechanism this proof depends on was independently, empirically re-confirmed this run by the existing, unmodified `R-B40-STRICT-B` (289ms, PASS) and `R-B40-STRICT-C` (155ms, PASS) tests, both of which exercise the same `establishDurableDispatchIntent` row-lock ordering against two genuinely separate real connections.

## Failure 1 — `TEST 008-I` (new test, Stage 2 authorship)

```
AssertionError: expected 4 to be 3 // Object.is equality
❯ src/lib/payments/paymentWebhookRecovery.postgres.test.ts:2874:27
  2872|     const afterEligible = new Date(deferredUntil.getTime() + 1_000);
  2873|     await retryService.fireDueRetries(afterEligible);
  2874|     expect(attemptNumber).toBe(3); // exactly one more dispatch — no duplicate.
```

**What is confirmed, not guessed:** the two earlier assertions in this same test (`attemptNumber === 2` after the initial `fireDueRetries(t0)` call, and `attemptNumber` still `2` after the `beforeEligible` call) both **passed** — the failure is isolated to the count observed after the third, `afterEligible` call. That means the jump from 2 to 4 (not 2 to 3) happened entirely within that single `fireDueRetries(afterEligible)` invocation — the resumption path dispatched to the provider **twice** in that one call, not once as the test's own design assumed.

**Root cause: not yet established.** `resolveNotFoundOutcome` (the method this path resolves through) was confirmed, by direct source reading before this test was written, to contain exactly one `provider.createPayment` call site. Why a single `fireDueRetries` invocation would reach it twice for the same retry row in this run has not been diagnosed — that would require either instrumented tracing against a live database (a further authorized run) or deeper static analysis of `PaymentRetryService.fireDueRetries`'s exact resumption-loop conditions than this report's scope covers. **This is reported as an open, unresolved, genuine test failure — not silently fixed, not worked around, and not explained away with an unverified guess.**

**No production code, migration, or test assertion was altered to make this pass.** The test remains exactly as executed, failing, in the repository.

## Failure 2 — `R-B51` (pre-existing test, not written or modified by any Stage 2 order)

```
AssertionError: expected 'processed' to be 'accepted' // Object.is equality
❯ src/lib/payments/paymentWebhookRecovery.postgres.test.ts:1486:29
  1486|     expect(attempt1.status).toBe("accepted"); // audit effect failed — event not yet fully processed
```

**Confirmed unrelated to this Stage 2 round's own changes:** `R-B51` is defined at line ~1444 of `paymentWebhookRecovery.postgres.test.ts`, **before** any of this round's new tests (008-F/008-F-BLOCKED/008-G/008-I, inserted after line ~2551) in file/execution order — Vitest runs tests within one file in definition order by default, so nothing this round added could have polluted state ahead of `R-B51`'s own execution. This test was not touched, referenced, or analyzed by any prior Stage 2 report. It is reported here in full because this order requires capturing **every** result, including failures unrelated to the requested work, not just the ones this round is directly responsible for. **No attempt was made to fix, explain, or dismiss this failure as a suspected flake** — it is recorded as a genuine, unresolved, pre-existing defect or environment-sensitivity requiring separate owner-directed investigation, outside this order's authorized scope (which is REM-008 008-C/F/G/H/I plus the four findings already corrected).

## Anomaly — `payoutService.postgres.test.ts` did not run

`src/lib/payouts/payoutService.postgres.test.ts` exists on disk (27,736 bytes) and matches `vitest.postgres.config.ts`'s own `include: ["src/**/*.postgres.test.ts"]` pattern, but **it produced zero output of any kind** in this run — no pass, no fail, no collection error, nothing. Only 7 of the 8 existing `*.postgres.test.ts` files actually executed. This was not caused by any change made under this Stage 2 order — no `payouts`-related file was touched by any correction in this round or the two preceding it. **This is disclosed as a genuine, unresolved anomaly requiring its own separate investigation** (why Vitest's file collection did not include it — a version glob, a module-resolution or import-time error swallowed silently, or something else) — not diagnosed further in this report, since doing so was outside the explicit scope of "run the authorized command once, capture results, then stop."

## Concurrency, idempotency, and financial-invariant evidence (from tests that passed)

- `R04-A`: 20+ concurrent `AuditService.record()` calls on genuinely distinct real connections all persisted, formed exactly one hash chain, every hash recomputed correctly — under the reduced-privilege runtime role.
- `R05-C`/`R05-D`, `R03-C`, the accept-vs-revision race: real lock-contention proofs, all passed under the runtime role.
- `B06`, `B31`, `B32`: concurrent webhook/retry races via genuinely separate connections (`createIsolatedDb`), all passed.
- `R-B40-STRICT-B`/`R-B40-STRICT-C`: the exact locking/idempotency mechanism the same-retry-race analysis depends on, empirically reconfirmed.
- 008-C/F/F-BLOCKED/G/H all passed on first real execution, validating the corresponding analysis and implementation from the prior two rounds.

No exactly-once claim beyond what these tests actually assert is made here; at-most-one local dispatch (proven by call-count assertions) and durable replay/idempotency (proven by row-identity assertions) are the specific properties these passing tests establish — nothing broader is claimed.

## Cleanup confirmation

`[test:postgres] stopping and removing this run's own container "pay2pay-pgtest-24592-3d4e3c98" (if it exists)` was logged; the harness's own `finalizeHarnessRun` always attempts this regardless of test outcome. Confirmed independently afterward:
```
docker ps -a --filter "name=pay2pay-pgtest-24592-3d4e3c98"   → 0 rows
docker ps -a --filter "label=pay2pay-test-harness=true"      → 0 rows
```
No container, from this run or any prior run, remains. The nonzero exit code (`1`) is exactly and only attributable to the 2 test failures — not to any cleanup failure.

## Changed-file inventory (this round)

| File | Change |
|---|---|
| `docs/remediation/STAGE_02_PHASE_C_REM008_POSTGRESQL_EXECUTION_REPORT.md` | **New** — this report |

No harness, test, configuration, or production file was modified this round. This round was execution-and-reporting only.

## Known coverage limitations

- `TEST 008-I` failed and is unresolved — 008-I's acceptance requirement is **NOT VERIFIED** (a failing execution is not a pass; it is also not silently ignored).
- `R-B51` failed — a pre-existing, unrelated defect or environment-sensitivity, unresolved, requiring separate owner-directed follow-up.
- `payoutService.postgres.test.ts` did not execute at all — its own coverage (payout-specific concurrency/idempotency, if any 008-adjacent requirement depends on it) is **NOT ESTABLISHED** by this run.
- Stage 3 (REM-009 provider authentication), Stage 7 (release-artifact certification), and REM-001/REM-002 comprehensive scanner hardening remain entirely outside this report's scope, as in every prior round.

## Stage boundary and next step

This report does not declare Stage 2 complete, does not declare overall REM-008 verified, and does not authorize Stage 3. Two genuine, unresolved failures and one unexplained non-execution are open items requiring the owner's explicit direction on how to proceed (e.g., a further authorized diagnostic run, or handoff to independent Codex review with these findings disclosed as-is). No commit, push, merge, or deployment occurred.

*End of report.*
