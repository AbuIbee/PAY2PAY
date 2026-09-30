# Paid2You Stage 1 Independent Verification Report

## A. Scope and governing evidence

This report independently verifies the Stage 1 assignment against the actual V3 worktree. The governing implementation report was `docs/remediation/STAGE_01_FINAL_IMPLEMENTATION_AND_EXIT_REPORT.md`. Repository instructions `AGENTS.md` and `CLAUDE.md` were read. No sibling worktree, production system, database, migration, or payment provider was accessed. No existing source, test, configuration, or Git state was modified.

## B. Repository state

Working directory: `C:\Development\PAY2PAY-bank-v3`  
Branch: `architecture/bank-managed-payments-v3`  
HEAD: `93bbbbf8950010d4c0a70c7133339dc352ebd0fd`

The worktree was already dirty. Observed changes included `.github/workflows/ci.yml`, `CLAUDE.md`, `package.json`, environment/configuration files, payment and retry services, notification services and tests, provider files, ledger files, renamed sandbox providers under `src/test-support`, scanner scripts, payout files, and remediation reports. Existing deletions included the sandbox settlement route. Untracked files included the Stage 1 report, activation-gate tests, notification tests, scanner tests/scripts, payment eligibility tests, and payout implementation/tests. No audit command changed this state.

## C. Independently executed checks

### C.1 Activation gate

Command:

```text
npx vitest run src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1 --reporter verbose
```

Result: exit 0; 27/27 tests passed.

### C.2 REM-015 notification suite

Command:

```text
npx vitest run src/lib/notify/productionFailClosed.test.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1 --reporter verbose
```

Result: exit 0; 16/16 tests passed.

### C.3 REM-013 recursion suite

Command:

```text
npx vitest run src/lib/failedPayments/productionFactoryRecursion.test.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1 --reporter verbose
```

Result: exit 0; 5/5 tests passed.

### C.4 Typecheck

Command: `npm run typecheck -- --incremental false`  
Result: exit 0; no TypeScript errors.

### C.5 Lint

Command: `npm run lint -- --no-cache`  
Result: exit 0; 0 errors and 12 warnings. Warnings were existing underscore-prefixed unused variables in admin, disputes, webhook-recovery, ledger, security, and test-support files.

### C.6 Sandbox scanner

Command: `npm run check-no-sandbox-runtime`  
Result: exit 0. The scanner reported 755 modules reachable from 307 production entry points, with no reachable sandbox provider, unresolved local import, or other violation.

### C.7 Adyen scanner

Command: `npm run check-no-adyen-dependency`  
Result: exit 0. No Adyen runtime reference, registry entry, package dependency, or lockfile dependency was reported.

### C.8 Full non-PostgreSQL suite

Command: `npx vitest run --no-cache --maxWorkers=4 --minWorkers=1`  
Result: exit 0; 257/257 test files and 2237/2237 tests passed.

### C.9 Checks intentionally not executed

The production build was not run because it writes `.next` output and the audit was strictly read-only. PostgreSQL integration tests were not run. No database connection, migration, or production access was attempted.

## D. SV-006 constructor and runtime authorization

Relevant files and functions:

- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:589-633` — constructor and authorization state.
- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:779` — `assertNewPaymentInitiationAuthorized`.
- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:1742-1860` — `dispatchProviderCallForAnchor`.
- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts:2158-2240` — `resolveNotFoundOutcome`.
- `src/lib/failedPayments/getFailedPaymentRetryCoordinator.ts:13-32` — production factory.
- `src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts:72-200` — runtime and compile-contract tests.

The constructor has seven positional arguments. Arguments four and six remain undefined-compatible slots. Argument seven is a required boolean with no optional marker, default, or `undefined` union. Existing argument ordering and earlier defaults remain intact. The factory passes `getServerEnv().PAYMENT_INITIATION_VERIFIED` in slot seven.

Both provider.createPayment paths invoke the authorization guard before provider submission. Focused tests prove false and undefined block primary dispatch and secondary redispatch, direct invocation cannot bypass the guard, the callable provider spy sees no submission, and blocked paths do not open the database transaction or falsely finalize a retry.

**SV-006: VERIFIED.**

## E. SV-007 factory AST verification

Relevant file: `src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts:267-435`.

`findProductionFactoryCoordinatorCall` identifies the exported top-level `getFailedPaymentRetryCoordinator` declaration, determines the identifier returned by that function, tracks binding shadowing, traverses only the factory body, excludes nested function bodies, unwraps parenthesized expressions, and associates the constructor with the factory-owned cache binding. `assertSeventhArgumentIsPaymentInitiationVerified` requires the actual seventh argument to be structurally `getServerEnv().PAYMENT_INITIATION_VERIFIED`.

The real production factory is `src/lib/failedPayments/getFailedPaymentRetryCoordinator.ts:13-32`; it assigns and returns the module-level cache and supplies the environment flag.

### Independent original false-pass reproduction

The real factory was transformed in memory only: its constructor was parenthesized, the seventh argument changed to `true`, and an unrelated function with a correctly configured `cached` constructor was appended. The actual current helper rejected the transformed source because the real factory argument was a hardcoded `true`. No on-disk source was changed.

### Regression matrix

| Case | Expected | Observed | Result |
|---|---|---|---|
| R1 current real factory | Accept | Accepted | PASS |
| R2 hardcoded `true` | Reject | Rejected | PASS |
| R3 exact original false-pass | Reject | Rejected | PASS |
| R4 correct parenthesized constructor | Accept | Accepted | PASS |
| R5 no construction in actual factory | Reject | Rejected | PASS |
| R6 ambiguous in-factory constructions | Reject | Rejected | PASS |
| R7 correct factory plus unrelated correct constructor | Accept | Accepted | PASS |
| R8 correct factory plus unrelated incorrect constructor | Accept | Accepted | PASS |
| R9 incorrect factory plus nested correct decoy | Reject | Rejected | PASS |
| R10 wrong environment property | Reject | Rejected | PASS |
| R11 six constructor arguments | Reject | Rejected | PASS |
| R12 expression only in a comment | Reject | Rejected | PASS |
| R13 expression elsewhere while real argument is `true` | Reject | Rejected | PASS |

Former NC-006 is correctly reconciled: constructors in separate functions are not ambiguous; only multiple matching assignments inside the actual factory are ambiguous.

**SV-007: VERIFIED.**

## F. REM-013 recursion verification

`src/lib/failedPayments/productionFactoryRecursion.test.ts` contains five tests. The independent suite passed 5/5. The tests exercise production factory bodies beyond provider initialization, constrain mocks to provider boundaries, cover recursion-sensitive dependency edges, and verify invocation-count instrumentation. A regression to eager construction would fail the relevant assertions.

**REM-013: VERIFIED for tested non-PostgreSQL behavior.**

## G. REM-015 email/SMS verification

Relevant files:

- `src/lib/notify/productionFailClosed.test.ts:46-112` — managed environment list, clean baseline, default-deny fetch, restoration.
- `src/lib/notify/productionFailClosed.test.ts:383-516` — deferred ordering tests.
- `src/lib/notify/getEmailSender.ts:20-28` — real email factory.
- `src/lib/notify/getSmsSender.ts:19-31` — real SMS factory.
- `src/lib/notify/notificationService.ts:255,784-864` — real service and delivery persistence.
- `src/config/env.ts:161-202` — credentials and delivery flags.

The independent suite passed all 16 tests. Coverage includes missing and incomplete credentials, disabled email and SMS, configured email and SMS success, provider failures, notification persistence, pending-state ordering, provider-success ordering, provider-failure ordering, and no real network delivery. The default fetch spy denies network access; configured tests replace it only with controlled mocks. `NotificationService.deliver` calls `markSent` only after the sender resolves successfully.

**REM-015: VERIFIED for tested non-network behavior.**

## H. S1-01 through S1-26 acceptance matrix

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| S1-01 | Read instructions | `AGENTS.md`, `CLAUDE.md` read | VERIFIED |
| S1-02 | Preserve changes | Existing dirty state preserved | VERIFIED |
| S1-03 | SV-006 | Source inspection and 27/27 tests | VERIFIED |
| S1-04 | Exported factory identity | AST helper and R1/R3 tests | VERIFIED |
| S1-05 | Shadow binding | Shadow, catch, block, nested tests | VERIFIED |
| S1-06 | Original exploit rejection | Independent in-memory reproduction | VERIFIED |
| S1-07 | SV-007 controls | R1-R13 all passed | VERIFIED |
| S1-08 | REM-013 | 5/5 tests | VERIFIED |
| S1-09 | Environment isolation | Clean baseline and restoration | VERIFIED |
| S1-10 | Default network deny | Default-deny fetch spy | VERIFIED |
| S1-11 | Hostile environment | Poisoned environment reset test | VERIFIED |
| S1-12 | Email ordering | Deferred email success/failure tests | VERIFIED |
| S1-13 | SMS ordering | Deferred SMS success/failure tests | VERIFIED |
| S1-14 | Notification coverage | 16/16 tests | VERIFIED |
| S1-15 | Provider isolation | Empty registry and scanner | PARTIAL; deployment state not tested |
| S1-16 | REM-001 | Deferred by approved Stage 1 decision | DEFERRED |
| S1-17 | REM-002 | Deferred by approved Stage 1 decision | DEFERRED |
| S1-18 | Focused suites | Activation, notify, recursion all pass | VERIFIED |
| S1-19 | Typecheck | Exit 0 | VERIFIED |
| S1-20 | Lint | Exit 0, 12 warnings, 0 errors | VERIFIED |
| S1-21 | Full non-PG suite | 257 files / 2237 tests pass | VERIFIED |
| S1-22 | Production build | Not run under read-only restriction | NOT INDEPENDENTLY TESTED |
| S1-23 | No PostgreSQL work | No database operation performed | VERIFIED |
| S1-24 | No REM-009 implementation | No REM-009 implementation performed | VERIFIED |
| S1-25 | Stage 7 | No Stage 7 work begun | VERIFIED |
| S1-26 | Evidence report | This report contains findings and limitations | VERIFIED |

## I. Provider and sandbox isolation

`src/lib/providers/providerCapabilities.ts:71` contains an empty provider capability registry. Sandbox providers are under `src/test-support`. The independent graph scanner traversed 755 modules from 307 production entry points and found no reachable sandbox implementation or unresolved local import.

The independent Adyen scanner found no Adyen runtime reference, registry entry, package dependency, or lockfile dependency.

These results verify the repository scanner coverage. They do not certify deployment infrastructure or an applied production environment.

## J. Failure reconciliation

Independent outcomes are:

- Typecheck: PASS.
- Lint: PASS, 12 warnings, 0 errors.
- Focused activation: PASS, 27/27.
- REM-015: PASS, 16/16.
- REM-013: PASS, 5/5.
- Full non-PostgreSQL suite: PASS, 257/257 files and 2237/2237 tests.
- Build: NOT EXECUTED because it can write `.next` output.
- PostgreSQL integration: NOT EXECUTED.

The Stage 1 report’s claimed build result was not independently reproduced. The initial recursion timeout described in that report was not reproduced in the controlled full run.

## K. Database and deferred limitations

No PostgreSQL tests, database connections, migrations, or database writes were performed. PostgreSQL-dependent recovery, payout, ledger, migration, and database-integrity requirements remain unverified. REM-009 remains outside this Stage 1 verification and was not implemented.

## L. Scope and historical attribution

Current source confirms the SV-006 guards, SV-007 helper, REM-013 tests, and REM-015 tests described above. The repository does not preserve a complete before-and-after snapshot for every dirty file; therefore, historical byte-level attribution of all changes is not claimed. The current Git state and current source are the evidence used here.

## M. Findings and remaining requirements

No additional source correction was identified for the independently verified non-database controls. Remaining work is limited to authorized PostgreSQL integration verification, database-backed payout/ledger/migration acceptance, any remaining REM-009 architectural decision, and independently reproducible build evidence in an isolated environment where generated output is permitted.

## N. Final classifications

```text
SV-006: VERIFIED
SV-007: VERIFIED
REM-013: VERIFIED for tested non-PostgreSQL behavior
REM-015: VERIFIED for tested non-network behavior
Overall Stage 1: PARTIAL pending PostgreSQL-dependent verification and independent build evidence
Typecheck: PASS
Lint: PASS (12 warnings, 0 errors)
Focused activation tests: PASS (27/27)
REM-015 tests: PASS (16/16)
REM-013 tests: PASS (5/5)
Full non-PostgreSQL unit suite: PASS (257/257 files, 2237/2237 tests)
Production build: NOT EXECUTED
PostgreSQL integration: NOT EXECUTED
Stage 2: NOT STARTED
```

## O. Delivery limitation

No native downloadable-artifact mechanism was available in this session. This report is being saved under the explicitly authorized V3 repository path. It requires manual transfer for external download. No other repository file is authorized to be written by this operation.
