# Paid2You Stage 2 Phase D Independent Acceptance Report

**Auditor:** Codex  
**Repository:** `C:\Development\PAY2PAY-bank-v3`  
**Branch:** `architecture/bank-managed-payments-v3`  
**HEAD:** `93bbbbf8950010d4c0a70c7133339dc352ebd0fd`  
**Mode:** Read-only independent audit. No Docker, PostgreSQL, migration, provider, production, or Stage 3 operation was performed.

## A. Repository identity and evidence inventory

Every shell invocation used the explicit authorized working directory `C:\Development\PAY2PAY-bank-v3`. The repository root, branch, and HEAD matched the order. `AGENTS.md` and `CLAUDE.md` were read. The worktree was already dirty; all existing staged, unstaged, and untracked changes were preserved. The sibling checkout `C:\development\pay2pay` was not accessed.

The following Stage 2 reports were inspected: `STAGE_02_PHASE_A_ARCHITECTURE_AND_ISOLATION_REPORT.md`, `STAGE_02_PHASE_B_ISOLATION_AND_HARNESS_EVIDENCE.md`, `STAGE_02_PHASE_B_SUPPLEMENTAL_EVIDENCE_AND_AUTHORIZATION.md`, `STAGE_02_PHASE_B_SUPPLEMENTAL_EXECUTION_REPORT.md`, `STAGE_02_PHASE_C_REM008_POSTGRESQL_EXECUTION_REPORT.md`, `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`, `STAGE_02_PHASE_C_FINAL_COMPLETION_REPORT.md`, `STAGE_02_PHASE_C_TWO_FAILURES_REMEDIATION_AND_EXECUTION_READINESS.md`, `STAGE_02_008I_EXACT_ASSERTION_FIX.md`, `STAGE_02_ROLE_OWNERSHIP_FINAL_CORRECTION_AND_PHASE_B_APPROVAL.md`, and `STAGE_02_FOUR_FINDINGS_REMEDIATION_AND_GATE_B_READINESS.md`.

The owner’s final screenshots referred to by the order were unavailable in this session. The reported totals of 281/281 PostgreSQL tests and 2,244/2,244 non-PostgreSQL tests are therefore owner-reported claims, not independently observed results. The earlier Phase C execution report records an actual run with exit code 1, 279/281 PostgreSQL tests passing, and failures in TEST 008-I and R-B51. Later reports describe offline corrections and an owner-reported 281/281 result without independently inspectable raw output, exit code, or cleanup output.

## B. PostgreSQL configuration and collection

`vitest.postgres.config.ts` currently uses:

```text
include: ["src/**/*.postgres.test.ts"]
fileParallelism: false
pool: "forks"
poolOptions.forks.singleFork: true
testTimeout: 90_000
hookTimeout: 30_000
setupFiles: ["./vitest.postgres.setup.ts"]
```

The seven matching files are:

1. `src/lib/agreements/generalTermsRevisionConcurrency.postgres.test.ts`
2. `src/lib/agreements/signingConcurrency.postgres.test.ts`
3. `src/lib/audit/auditService.postgres.test.ts`
4. `src/lib/ledger/installmentAmountAwareness.postgres.test.ts`
5. `src/lib/payments/paymentWebhookRecovery.postgres.test.ts`
6. `src/lib/relationships/relationshipFinancialAccountService.postgres.test.ts`
7. `src/lib/settlements/settlementBinding.postgres.test.ts`

The current files total 281 tests according to the report’s arithmetic (157 + 89 + 14 + 11 + 3 + 4 + 3). A source search found no executable `.skip`, `.only`, `.todo`, `xit`, or `xdescribe` modifier. The only match was “only” inside a comment. PostgreSQL suites are excluded from the ordinary Vitest configuration and run only through the harness’s explicit `--run-tests` branch.

## C. REM-008 production trace

Relevant source:

- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:1598-1722` — `establishDurableDispatchIntent`.
- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:1844-1941` — primary provider call and execution-token fencing.
- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:2059-2140` — ambiguous resolution.
- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:2158-2294` — not-found redispatch and fencing.
- `src/lib/failedPayments/paymentRetryService.ts:390-530` — due retries and claimed resumption.

The source uses deterministic `retry-${retryId}` idempotency keys, durable payment-attempt anchors, claimed status, execution tokens, fresh token confirmation, and `nextResolutionAttemptAt` backoff. The two provider submission sites are coordinator lines 1868 and 2244. The source also shows agreement/installment locking before the conditional scheduled-to-claimed update.

The current PostgreSQL tests are in `src/lib/payments/paymentWebhookRecovery.postgres.test.ts`:

| Requirement | Test location | Source behavior |
|---|---:|---|
| 008-C | 2537 | Authorized retry reaches provider and fires. |
| 008-H | 2554 | Disabled initiation preserves claim/token/anchor and later authorized recovery. |
| 008-F | 2622 | Not-found redispatch uses the same idempotency key and persists. |
| 008-F-BLOCKED | 2708 | Disabled redispatch makes no provider call and remains recoverable. |
| 008-G | 2776 | Historical webhook processing succeeds while new retry initiation is disabled. |
| 008-I | 2819 | Repeated recovery, durable backoff, and identity/uniqueness assertions. |
| R-B51 | 1445 | Current `payout.paid` safe no-op behavior. |

The corrected 008-I source uses a per-key provider-call counter and asserts the original attempt remains present, exactly one retry-key row exists, and that row equals the resulting retry attempt. These are source-level assertions only in this audit because no PostgreSQL execution was authorized.

### REM-008 status matrix

| Requirement | Current source | Reported execution evidence | Independent result |
|---|---|---|---|
| 008-C | Traceable and tested in source | Earlier Phase C PASS; later PASS is owner-reported | OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED |
| 008-F | Traceable and tested in source | Earlier Phase C PASS; later PASS is owner-reported | OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED |
| 008-F-BLOCKED | Traceable and tested in source | Earlier Phase C PASS; later PASS is owner-reported | OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED |
| 008-G | Traceable and tested in source | Earlier Phase C PASS; later PASS is owner-reported | OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED |
| 008-H | Traceable and tested in source | Earlier Phase C PASS; later PASS is owner-reported | OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED |
| 008-I | Corrected source and exact identity assertions | Earlier real run failed; later real-PG PASS is owner-reported without logs | BLOCKED — REQUIRED REAL-PG EVIDENCE MISSING |
| Same-retry competing workers | Locking/CAS and token fencing source-inspected | Related R-B40 evidence reported, exact run unavailable | SOURCE-SUPPORTED; RUNTIME UNCONFIRMED |
| R-B51 | `paymentWebhookService.ts:693-701` safe no-op; test line 1445 | Earlier failure preceded rewrite; later PASS owner-reported | OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED |

`payout.paid` is handled as an unrecognized-event safe no-op and does not create a second creditor payout. No current PostgreSQL payout-service test was found; the reports disclose this broader coverage gap.

## D. PostgreSQL harness audit

Relevant files and lines:

- `scripts/postgres-test-db.mjs:282` — `verifyContainerIdentity`.
- `scripts/postgres-test-db.mjs:316` — `verifyDatabaseIdentity`.
- `scripts/postgres-test-db.mjs:391-410` — runtime role statements.
- `scripts/postgres-test-db.mjs:514-540` — scratch transaction.
- `scripts/postgres-test-db.mjs:582-822` — lifecycle and cleanup.
- `test/postgres/verifyHarnessOwnership.mjs:1-112` — static URL/marker protection.
- `test/postgres/outboundTransportGuard.mjs:66-110` — outbound guard.
- `vitest.postgres.setup.ts:18-31` — ownership check and guard installation.

### Identity and ordering

The harness generates a unique container name and run token, runs `docker inspect` before database contact, validates immutable container ID, exact name, labels, image, and running state, then checks `current_database()` and `current_user` before migrations or other schema writes. `verifyHarnessOwnership` validates protocol, loopback host, non-forbidden port, and run token before creating a database client, then requires the exact run marker.

Current order is:

```text
docker run → port discovery → resolved-target validation → docker inspect
→ database identity → marker create/verify → migrations
→ runtime role/scratch setup → runtime-role checks and scratch rollback
→ optional --run-tests → unconditional cleanup
```

Source inspection establishes that identity or marker failure prevents migrations, role creation, and test execution. No bootstrap-role fallback exists after runtime-role failure.

### Role and RLS limitation

`pay2pay_test_runtime` is created with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS`, DML grants on existing tables/sequences, no ownership transfer, and marker-table write revocation. `BYPASSRLS` is the explicitly accepted exception. These tests therefore do **not** prove RLS enforcement against the runtime role; the role intentionally bypasses RLS to preserve the existing bootstrap-role behavior. This limitation is disclosed and not converted into a false security claim.

### Scratch, transport, and cleanup

The scratch helper performs `BEGIN`, insert, read-back, `ROLLBACK` in `finally`, and post-rollback zero-row verification. The outbound guard synchronously denies `fetch`, `http.request`, `http.get`, `https.request`, and `https.get`; it leaves `net` and `tls` available for the local PostgreSQL wire protocol. This is process-level interception, not OS-level egress isolation. No reachable real provider transport was found in the inspected PostgreSQL tests.

Cleanup is structurally unconditional and targets only the generated container. The Phase B reports claim exit 0 and zero remaining harness-labeled containers, but the underlying screenshots/raw output were unavailable in this session. Runtime cleanup is therefore owner-reported, not independently established.

## E. Report discrepancies

1. The actual earlier Phase C report records 279/281 and failures in 008-I and R-B51; the later completion report records 281/281 only as an owner claim without attached runtime evidence.
2. Earlier text claimed a `payoutService.postgres.test.ts`; the current authorized worktree has no such file, and the later report retracts that claim. No PostgreSQL payout-service coverage exists.
3. Some harness comments retain historical eight-file wording, while the current Vitest glob matches seven files. The executable configuration is clear.
4. Phase B supplemental evidence treats runtime-role and scratch checks as source-inferred from fail-closed control flow; raw `pg_roles`, privilege, scratch-row, and exact container identity values were not supplied.
5. `BYPASSRLS` intentionally replaced earlier `NOBYPASSRLS` expectations. The current reports correctly identify and accept this exception.

## F. Owner evidence versus independent evidence

Independently established in this audit:

- Repository root, branch, HEAD, instructions, current files, and dirty state.
- Seven-file PostgreSQL configuration and absence of executable skip/exclude modifiers.
- Current production recovery source, idempotency keys, token fencing, lock/CAS structure, backoff, webhook no-op, and corrected test assertions.
- Harness source ordering, identity checks, marker gate, role statements, BYPASSRLS disclosure, scratch transaction, outbound guard, and unconditional cleanup structure.

Not independently established:

- A real PostgreSQL PASS for 008-C, 008-F, 008-F-BLOCKED, 008-G, 008-H, corrected 008-I, or R-B51 after the final corrections.
- The owner-reported 281/281 result.
- The owner-reported 2,244/2,244 non-PostgreSQL result.
- The later run’s process exit code.
- The later run’s exact container identity and cleanup output.
- Runtime enforcement of RLS; BYPASSRLS expressly prevents that claim.

## G. Acceptance disposition

Stage 2 cannot be independently accepted from the available evidence. This is a specific evidence blocker, not a newly demonstrated production-code defect. The prior actual PostgreSQL execution failed 008-I and R-B51. Offline corrections are present, and a later 281/281 result is claimed, but the required real-run evidence is not available for independent verification.

The minimum separately authorized evidence needed is:

```text
node scripts/postgres-test-db.mjs --run-tests
```

against one newly generated disposable `postgres:17-alpine` container, with:

1. Raw output showing all seven files and all 281 tests passing.
2. Exit code 0 from that same run.
3. Explicit PASS for 008-C, 008-F, 008-F-BLOCKED, 008-G, 008-H/I, corrected 008-I, and R-B51.
4. Post-run proof that the generated container was removed.
5. No production, shared, hosted, sibling, or real-provider access.

This audit did not execute that command. Separate owner authorization is required. No source or test correction is authorized or proposed by this report.

## H. Final status

```text
Repository identity: VERIFIED
Branch and HEAD: VERIFIED
Current source implementation: SOURCE-SUPPORTED
Harness ordering and fail-closed structure: SOURCE-VERIFIED
BYPASSRLS exception: DISCLOSED AND OWNER-ACCEPTED IN REPORTS
RLS enforcement proof: NOT CLAIMED
Outbound provider isolation: SOURCE/OFFLINE-TEST SUPPORTED
PostgreSQL collection: 7 files; no executable skip/exclude modifiers found
008-C: OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED
008-F: OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED
008-F-BLOCKED: OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED
008-G: OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED
008-H: OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED
008-I: BLOCKED — REQUIRED REAL-PG PASS EVIDENCE MISSING
R-B51: OWNER-REPORTED PASS; NOT INDEPENDENTLY VERIFIED
Container cleanup: SOURCE-VERIFIED; RUNTIME CONFIRMATION UNAVAILABLE
Stage 2: ACCEPTANCE BLOCKED — SPECIFIC REQUIRED EVIDENCE MISSING
Stage 3: NOT STARTED
```

## I. Delivery

This report is the only file created by this audit. No application code, test, migration, financial configuration, existing report, Git state, database, provider, deployment, or production system was modified.
