# Paid2You Stage 3 Independent Acceptance Report

**Auditor:** Codex  
**Audit date:** 2026-09-21  
**Overall disposition:** STAGE 3 BLOCKED  REQUIRED EVIDENCE OR AUTHORIZATION MISSING

## 1. Authority, identity, and audit boundary

This is the single read-only audit requested by the Project Owner's Stage 3 Final Independent Codex Acceptance Audit, Orders 01-07. No test, compiler, linter, build, Docker command, database connection, provider operation, or deployment was executed. Only this new Markdown report was created. No earlier report, application file, test, configuration, migration, staged change, or untracked file was altered. No Stage 4 work occurred.

Every shell invocation began with Set-Location to the authorized repository and checked the resulting working directory before repository commands. Verified:

- Working directory: `C:\Development\PAY2PAY-bank-v3`.
- Git root: `C:/Development/PAY2PAY-bank-v3`.
- Branch: `architecture/bank-managed-payments-v3`.
- HEAD: `93bbbbf8950010d4c0a70c7133339dc352ebd0fd`.

Root AGENTS.md and CLAUDE.md were read. No descendant AGENTS.md was found under src, docs, test, or scripts. The master specification had been read in the preceding audit work. No code was written, so the Next.js guide-before-code rule did not require a framework implementation review. No conflicting instruction was encountered in the actions taken. No sibling checkout or external evidence directory was accessed.

Stages 1 and 2 remain accepted baselines. The Stage 2 final addendum was read solely for accepted boundaries and limitations. Its prior execution evidence is not substituted for Stage 3 evidence, and no repeat of the 281-test campaign is requested.

## 2. Critical evidence finding: the saved report is still the earlier version

The actual `docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md` was read in full. It has 245 lines, is 35,467 bytes, and ends with Section V at line 241 and “End of report” at line 245. Its last-write timestamp is `2026-09-21T17:44:45.0371342Z`.

It contains the original blocked Sections A-K and the later third-factory correction in Sections L-V. It does **not** contain a subsequently completed database-acceptance section after A-V. Section S (195-205), the matrix at 207-223, and handoff at 225-239 still identify missing persisted-result evidence and database authorization.

Neither exact test identity was found:

- `STAGE3-G03-REAL-FACTORY-POSTGRES-RECOVERY`.
- `STAGE3-G04-REAL-FACTORY-POSTGRES-RETRY-STATUS`.

Searches included hidden and ignored repository files, excluding dependency/build directories. The existing seven PostgreSQL test files were enumerated. No PostgreSQL test imports either real production factory by name. No Stage 3 stdout/stderr log, captured child/harness exit record, target/context preflight, selected-run command record, or post-run cleanup artifact was located. The current report cites no completed Stage 3 evidence bundle from which these could be read.

This is a missing-artifact finding in the authorized checkout, not proof that an execution elsewhere failed or never occurred. The Owner's statement that the gates are evidenced cannot replace the missing files under Orders 01.6-9 and 04.

## 3. Scope and construction-chain audit

The saved Stage 3 changes supported by the report and present source are:

| File | Inspected lines | Stage 3 change |
|---|---:|---|
| src/lib/payments/getPaymentWebhookService.ts | 24-55, especially 30-32 | Eager provider dependency replaced by lazy getter; remaining dependencies are sibling properties |
| src/lib/failedPayments/getPaymentRetryService.ts | 22-88, especially 39-41 | Same getter; eligibility, effectApplier, and initiators remain sibling properties |
| src/lib/payments/getPaymentService.ts | 53-81, especially 57-58 | Owner's third-factory getter; closing brace and comma are present despite unusual formatting |
| src/lib/payments/getPaymentWebhookService.test.ts | 13-86 | Two new tests: G01 cold construction and G05 provider-unavailable inbound call |
| src/lib/failedPayments/getPaymentRetryService.test.ts | 15-90 | Two new tests: G02 cold construction and G06 provider-unavailable retry firing |
| Subsequent PostgreSQL acceptance additions | Not found | Neither required named case nor a corresponding new source file is available |

The full diff against HEAD also contains older environment-gate wiring in getPaymentService/getPaymentRetryService and payout dependency wiring in getPaymentWebhookService. HEAD is an older dirty baseline, not a clean Stage 3 start. Those hunks cannot all be attributed to Stage 3. The original inventory already contains broad prior-stage modifications; the current implementation report Sections B/M/N attributes only the provider-getter changes to this work. No concrete unauthorized Stage 3 production/schema/provider/authentication/ledger/payout change was established. There is no saved pre-Stage-3 content snapshot proving a byte-for-byte campaign-only diff; that attribution boundary is disclosed rather than turning all dirty files into alleged new changes.

Actual chain inspected:

```text
getPaymentWebhookService
  -> getFailedPaymentWorkflowService
     -> getPaymentRetryService
        -> getFailedPaymentRetryCoordinator
        -> getAchPaymentService -> getPaymentService
        -> getDebitCardPaymentService -> getPaymentService
```

Relevant construction sources: failedPayments/getFailedPaymentWorkflowService.ts:11-23; ach/getAchPaymentService.ts:10-20; debitCard/getDebitCardPaymentService.ts:11-22; failedPayments/getFailedPaymentRetryCoordinator.ts:13-32. ACH mandate, debit-card method, notification, and payout factory wiring were also inspected for provider dependencies.

PaymentService's constructor ends with an empty body at paymentService.ts:493-541; ACH and debit-card constructors are empty at achPaymentService.ts:16-35 and debitCardPaymentService.ts:26-40. FailedPaymentWorkflowService's constructor is empty at failedPaymentWorkflowService.ts:29-37. PaymentWebhookService initializes only platformFeePolicy at paymentWebhookService.ts:481-551; PaymentRetryService initializes only delayBusinessDays at paymentRetryService.ts:258-298. None spreads/destructures/enumerates the supplied dependency object or reads its provider during construction.

Singleton assignment occurs after each constructor completes. The retry effectApplier remains a deferred method at getPaymentRetryService.ts:67-69; the installmentHook remains deferred at getPaymentService.ts:76-78. Neither is invoked during construction. No partial singleton placeholder or recursive eager callback was introduced.

The real provider factory remains fail-closed: getPaymentProvider.ts resolves through assertProviderAvailableForRuntime; providerCapabilities.ts:71 retains an empty registry. There is no fallback financial provider, fabricated registry entry, or swallowed availability exception in the three corrections.

## 4. Execution-record provenance and chronology

The following are **Claude-recorded results in the inspected report**, cross-checked with current source and assertions. Codex did not execute them. No separate raw non-PostgreSQL output or independently captured exit artifact was located; the gate assessment does not mislabel narrative records as independently reproduced runtime results.

| Record | Actual recorded command | Recorded result |
|---|---|---|
| Report F, lines 74-83, initial regression | `npx vitest run` | 258 passing / 2 failing files; 2,244 passing / 4 failing tests, 2,248 total; exit 1 |
| Report M, lines 129-147, owner's first two corrections | `npm run typecheck` | First: 17 syntax errors, exit 2. Second: one comma error, exit 2 |
| Report M/O, lines 149-171, corrected getter | `npm run typecheck`; `npx vitest run src/lib/payments/getPaymentWebhookService.test.ts src/lib/failedPayments/getPaymentRetryService.test.ts` | Typecheck exit 0; four factory tests pass, exit 0 |
| Report P, lines 173-179 | Focused six-file command below | 77/77 tests, six files, exit 0 |
| Report R, lines 185-193 | `npm run typecheck` (`tsc --noEmit`) | Zero errors; exit 0 |
| Report R | `npm run lint` (`eslint`) | Zero errors; twelve described pre-existing warnings; exit 0 |
| Report R | `npx vitest run` | 260/260 files; 2,248/2,248 tests; exit 0 |

The exact recorded focused command is:

```text
npx vitest run src/lib/payments/paymentWebhookService.test.ts src/lib/failedPayments/paymentRetryService.test.ts src/lib/failedPayments/productionFactoryRecursion.test.ts src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts src/lib/payments/getPaymentWebhookService.test.ts src/lib/failedPayments/getPaymentRetryService.test.ts
```

The arithmetic is 18 + 23 + 5 + 27 + 2 + 2 = 77. The original four failures correspond to G01/G02/G05/G06 and preceded the syntactically corrected third getter. They are historical, not simultaneous current failures.

Qualifications:

- Section P's heading overstates the ACH/debit-card evidence as “independently confirmed”: the paths execute as sibling object properties, but neither has an individual invocation spy. Section U at line 229 correctly discloses this source inference.
- The report's statement that the webhook constructor is a plain parameter property is imprecise: it also initializes platformFeePolicy. Inspection confirms that initialization does not access provider.
- The report's provider-use summary is incomplete: paymentService.ts also reads providerName at 813/829, and receiveWebhook reads provider for both verification and parsing at 554/560. All are method-time reads, so this does not undermine lazy construction.
- Section F compares with a 257-file/2,237-test earlier baseline; that is not the Stage 2 final screenshot baseline of 258 files/2,244 tests. Adding two files/four cases gives the final 260/2,248 figures. The old comparator is not a new failure.
- The twelve lint warnings' exact locations and run timings were not supplied; their pre-existing identity is report-recorded, not independently compared warning-by-warning.
- Section U:231 records no executable edits after the last successful regression. Current getter contents agree with the accepted third attempt. File timestamps precede the report; absent a run-time source manifest and timestamps, they cannot independently prove the entire edit chronology.
- No later two-case PostgreSQL addition exists in this checkout, so its separate compile/lint result is unavailable as well. No new compile/lint requirement is invented; the blocking fact is the absent mandatory persisted-result evidence. PostgreSQL tests are excluded by vitest.config.ts:25, so the full non-PostgreSQL result would not prove them in any event.

## 5. G01-G12 evidence matrix

VERIFIED below means the scoped contract is supported by independently inspected source/assertions plus the explicitly attributed existing execution record; it does not mean Codex reran tests.

| Gate | Condition and inspected evidence | Provenance/limitation | Disposition |
|---|---|---|---|
| G01 | Real cold webhook factory, zero provider resolutions, recoverBatch exposed. getPaymentWebhookService.test.ts:23-39 resets modules; 43-51 supplies throwing boundary; 54-69 imports actual factory, asserts count 0 and singleton equality. Report O/P records PASS. | No mock factory or provider-success double in this test; no DB operation asserted. | VERIFIED |
| G02 | Real cold retry factory, count 0, findForOriginalPayment exposed. getPaymentRetryService.test.ts:25-41 resets modules; 45-53 throwing boundary; 56-72 actual factory and equality/count assertions. Report O/P records PASS. | Exposes lookup but does not execute a persisted lookup. | VERIFIED |
| G03 | Actual factory recoverBatch on committed historical evidence with exact persisted effects and no new dispatch. Production path paymentWebhookService.ts:634-675 inspected. | Required named PostgreSQL test and run missing; construction/exposure cannot prove recovery. | BLOCKED |
| G04 | Actual factory findForOriginalPayment returns the exact persisted retry without mutation/dispatch. Production path paymentRetryService.ts:372-380 reads original, checks both owners, then reads retry. | Required named PostgreSQL test and run missing; in-memory tests at paymentRetryService.test.ts:92-111 do not substitute. | BLOCKED |
| G05 | Unavailable authentication provider prevents inbound verification and every unauthenticated effect. Factory test at getPaymentWebhookService.test.ts:71-85 records rejection and provider invocation; source paymentWebhookService.ts:553-564 accesses throwing getter before parsing or claimAndProcess. | Zero effects are independently established by statement-order inspection, not by exception alone or explicit financial-effect spies. No signatureVerified write, status change, ledger write, or success finalization is reachable after this throw. Report O/P records PASS. | VERIFIED |
| G06 | fireDueRetries fails closed with no unavailable-provider dispatch or retry mutation; eligibility guards retained. Test getPaymentRetryService.test.ts:74-89 plus paymentRetryService.ts:390-409, 428-473, 489-508. | Test uses generic rejects.toThrow and count >=1, not repository/state spies. Source confirms provider throw precedes due lookup and per-item try/catch, so no markCanceled or dispatch occurs in this condition. Preparation/eligibility precede authorized dispatch. Report O/P records PASS. | VERIFIED |
| G07 | No new submission while initiation disabled. Activation tests TEST 008-A/B/D/E and direct private-boundary case at failedPaymentRetryCoordinatorActivationGate.test.ts:73-163 assert zero createPayment and exact ambiguous outcomes; throwing DB forbids transactions. Factory env wiring at getFailedPaymentRetryCoordinator.ts:29; PaymentService guard at 566-570. | Report P records 27/27; this includes AST/mutation checks, not 27 database tests. REM-009 webhook tests at paymentWebhookService.test.ts:255-320 exercise historical effects with an in-memory fixture. | VERIFIED |
| G08 | Cold/repeated construction, stable singleton, no recursion, deferred callbacks, ACH/debit-card paths. productionFactoryRecursion.test.ts:137-212 (TEST 013-A/B/C/D and spy sanity check), actual wrappers at 104-134; G01/G02 assertions above. | Report P records 5/5 plus four factory tests. Recursion tests use inert provider boundary and real importActual wrappers; successful processing is not faked. ACH/debit-card invocation is a source/evaluation-order conclusion at retry factory:70-72, not individual factory instrumentation. Later payment-callback execution is not claimed tested. | VERIFIED |
| G09 | Preserve financial provenance, identity, idempotency, authorization, required effects and payout separation within getter-only scope. paymentWebhookService.ts:553-564, 592-626, 646-675, 703-828, 1380-1446, 1515-1518; paymentRetryService.ts:372-380, 437-448. | Current source retains event/token fencing, exact provider/payment identity, strict lookup amount/currency/fee checks, required ledger path, and payout.paid no-op at 692-701. Existing unit replay/unknown-payment/stale-event assertions and retry lifecycle tests are recorded passing in P. Scope attribution follows Section 3; not full ledger/settlement/payout certification. | VERIFIED |
| G10 | Audit final focused/typecheck/lint/non-PG regression records and preserve chronology. Report O/P/R/U with actual test source and config checked. | Recorded 77/77, compiler/linter exit 0, twelve warnings, 260/2,248 final exit 0. Raw outputs/timestamps and new PG-file checks absent as qualified above; Order 05 permits existing records where separate outputs are unavailable. | VERIFIED |
| G11 | Exactly two named real-factory PostgreSQL tests in one authorized disposable run, target/isolation identity, child/harness success and confirmed cleanup. | Neither test source, selected command, execution/exit record, local-context/preflight record, nor cleanup proof found. Harness source alone is not execution evidence. | BLOCKED |
| G12 | Complete independent report supports every mandatory G01-G11 gate before technical acceptance. | This report is complete for the available evidence, but mandatory G03/G04/G11 remain blocked. | BLOCKED |

Exact new factory test names inspected:

1. `G01 — a cold construction succeeds with the provider unavailable, resolves the provider ZERO times during construction, and exposes recoverBatch`
2. `G05 — receiveWebhook on the real factory-constructed service rejects under the existing provider-unavailable contract, resolving the provider (not zero) only at actual invocation time, before any event claim/processing could occur`
3. `G02 — a cold construction succeeds with the provider unavailable, resolves the provider ZERO times during construction, and exposes findForOriginalPayment`
4. `G06 — fireDueRetries on the real factory-constructed service still fails closed when the provider is unavailable, before any due-retry lookup or dispatch is attempted`

All four use the actual exported factory functions and reset module caches before dynamic import. The provider boundary throws rather than fabricating success. Their assertions do not establish G03/G04 persisted results.

## 6. Required PostgreSQL run: exact assessment

Both named test outcomes are **unverified because source and execution evidence are missing**, not failed.

| Required fact | Finding |
|---|---|
| G03 cold real factory, unavailable provider, committed recoverable event, actual recoverBatch, exact post-state, no duplicate effect/new payment | No named source or runtime result available |
| G04 cold real factory, committed valid original attempt/retry, exact authorized record identity, unchanged persisted state, zero dispatch | No named source or runtime result available |
| One selected invocation executing exactly both tests, neither skipped | No recorded invocation or output available |
| Child-process and harness exit statuses, stdout/stderr, timings | No Stage 3 records available |
| Local Docker context, postgres:17-alpine, loopback disposable target, matching token/container/DB identity | No Stage 3 run-specific preflight or identity records available |
| Inherited database URLs could not redirect execution; same approved DB holds both fixtures/effects | No run-specific records available |
| Outbound controls actually installed for this run | Source support only; no run proof |
| Exact generated container removed by harness; post-check absence; no unrelated removals | No Stage 3 cleanup record available |
| Source/run hashes and one-run correlation | No Stage 3 run manifest supplied |

The current harness only recognizes presence of `--run-tests` at scripts/postgres-test-db.mjs:340-341. Its child command at 780 is `npx vitest run --config vitest.postgres.config.ts`; it does not forward additional filename/test-name arguments. The configuration includes all `src/**/*.postgres.test.ts` at vitest.postgres.config.ts:28. Therefore appending a filter to the harness command cannot be assumed to run only two tests. This is a concrete selection-proof issue to resolve in the missing artifacts, not a reason to alter or rerun the accepted Stage 2 harness during this audit.

Source shows runtime URL/token supplied to the child at harness:782, child result assigned at 785, and cleanup in finally at 795-798. vitest.postgres.setup.ts:21-34 verifies ownership and installs the outbound guard. The guard at test/postgres/outboundTransportGuard.mjs:77-106 denies fetch and HTTP(S), not net/tls; it is process-level interception, not an OS firewall. Accepted BYPASSRLS behavior does not prove RLS enforcement. None of these source facts substitutes for this missing run's actual isolation/exit/cleanup records.

No fixture validity, signature provenance, commit visibility, exact recovery effect, or unchanged retry row can be audited for nonexistent supplied test sources. Empty batches, null lookups, manually constructed services, or earlier Stage 2 tests would not satisfy these requirements.

## 7. Minimum remaining Owner action

Provide the already completed, current Stage 3 artifacts in this authorized checkout: the updated report after Section V; both exact named acceptance-test sources; the actual selected command/selection mechanism; the same run's stdout/stderr and captured child/harness exits; authorization and local disposable target/preflight records; and exact-container post-run cleanup verification. No new execution is requested merely to replace unavailable files. If those records exist elsewhere, their authorized in-repository handoff is the minimum needed.

If they were never produced, the minimum later decision is separate authorization for the two narrowly scoped persisted-result tests and one correctly selected disposable run with those records. The present audit grants no such implementation or execution permission.

No demonstrated new production defect requires a code repair from this audit. No earlier accepted limitation is reopened. Stage 3 cannot yet be offered as technically accepted; only the Project Owner can decide final acceptance after the missing mandatory evidence is available and independently assessed.

## 8. Artifact fingerprints and provenance

These hashes were calculated from current saved bytes during this audit. They are inspection fingerprints, not historical run manifests or proof of execution.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md | 35467 | B0DCA77ACBB64836880791C4EACF953712C098418FDC6A7783FA50BD620A9CA0 |
| docs/remediation/Paid2You_Codex_Stage02_Final_Acceptance_Addendum.md | 11460 | BFE7593277507FF5561A8A80719EF6A6FD4669B963B54A8E7AF8C4707CEF4ED6 |
| src/lib/payments/getPaymentWebhookService.ts | 3873 | FA9590993C0D335D1A91C96CBB92D796CDE1BA474B5369EC53CF30B4981E1EF5 |
| src/lib/failedPayments/getPaymentRetryService.ts | 6046 | 8956EC0B73E5D325360D29A31F8F413C5C48B1A50B70422318EC0E8913F16228 |
| src/lib/payments/getPaymentService.ts | 5591 | 8191A8D94DEAA4BF3E93057829DCED877692FE76A770BE84D34460EA81ABD9E3 |
| src/lib/payments/getPaymentWebhookService.test.ts | 4364 | 39A99C4DC37AE674C617C1A3346FD00356F8CB5B5E4428C9810A881BE62B5AA0 |
| src/lib/failedPayments/getPaymentRetryService.test.ts | 4666 | 0FC59953389EC7BA8EC126149A89BC502535307462FC9325FB5B6F8356C69140 |

Other inspected sources are identified by path/line in Sections 3-6. Existing report claims are distinguished throughout from original runtime artifacts and source-only conclusions. No external Stage 2 bundle was reread for Stage 3.

## 9. Original Git inventory

The initial short status was recorded before source review; the expanded inventory below preserves all 117 individual entries, including files beneath the originally collapsed untracked payout directory. These are pre-audit entries, not an attribution of authorship or stage. No reset, restore, clean, stash, branch switch, staging, commit, push, or merge was used.

```text
 M .github/workflows/ci.yml
 M CLAUDE.md
 M package.json
 M scripts/postgres-test-db.mjs
 M scripts/postgres-test-db.test.mjs
D  src/app/api/admin/sandbox/simulate-settlement/route.test.ts
D  src/app/api/admin/sandbox/simulate-settlement/route.ts
 M src/app/api/payments/by-agreement/route.test.ts
 M src/app/api/payments/by-agreement/route.ts
 M src/app/api/payments/detail/route.test.ts
 M src/app/api/payments/detail/route.ts
 M src/app/api/relationships/accounts/bank/connect/route.test.ts
 M src/components/PaymentDetail.test.tsx
 M src/components/PaymentDetail.tsx
 M src/components/PaymentsList.test.tsx
 M src/components/PaymentsList.tsx
 M src/config/env.ts
 M src/db/schema/enums.ts
 M src/db/schema/index.ts
 M src/lib/ach/achPaymentService.ts
 M src/lib/ach/getAchPaymentService.ts
 M src/lib/ach/testFakes.ts
 M src/lib/admin/environmentStatus.test.ts
 M src/lib/admin/environmentStatus.ts
 M src/lib/admin/testFakes.ts
 M src/lib/cards/getCardIssuingProvider.ts
 M src/lib/cards/testFakes.ts
 M src/lib/debitCard/debitCardPaymentService.test.ts
 M src/lib/debitCard/debitCardPaymentService.ts
 M src/lib/debitCard/getDebitCardPaymentService.ts
 M src/lib/debitCard/testFakes.ts
 M src/lib/errors.ts
 M src/lib/failedPayments/failedPaymentRetryCoordinator.ts
 M src/lib/failedPayments/getFailedPaymentRetryCoordinator.ts
 M src/lib/failedPayments/getPaymentRetryService.ts
 M src/lib/failedPayments/productionFactoryRecursion.test.ts
 M src/lib/kyc/getKycProvider.ts
 M src/lib/kyc/testFakes.ts
 M src/lib/ledger/concurrencyAndIdempotency.test.ts
 M src/lib/ledger/installmentAmountAwareness.postgres.test.ts
 M src/lib/ledger/ledgerService.ts
 M src/lib/ledger/paymentLedgerIntegration.test.ts
 M src/lib/notify/consoleEmailSender.ts
 M src/lib/notify/consoleSmsSender.ts
 M src/lib/notify/getEmailSender.ts
 M src/lib/notify/getSmsSender.ts
 M src/lib/payments/drizzlePaymentAttemptRepository.ts
 M src/lib/payments/getPaymentProvider.ts
 M src/lib/payments/getPaymentService.ts
 M src/lib/payments/getPaymentWebhookService.ts
 M src/lib/payments/paymentInitiationEligibilityService.ts
 M src/lib/payments/paymentService.test.ts
 M src/lib/payments/paymentService.ts
 M src/lib/payments/paymentWebhookRecovery.postgres.test.ts
 M src/lib/payments/paymentWebhookService.test.ts
 M src/lib/payments/paymentWebhookService.ts
 M src/lib/payments/testFakes.ts
 M src/lib/providers/providerCapabilities.test.ts
 M src/lib/providers/providerCapabilities.ts
 M src/lib/relationships/bankConnectionService.test.ts
 M src/lib/settlements/settlementBinding.postgres.test.ts
 M src/lib/ui/statusLabels.test.ts
 M src/lib/ui/statusLabels.ts
RM src/lib/cards/sandboxCardIssuingProvider.ts -> src/test-support/cards/sandboxCardIssuingProvider.ts
RM src/lib/kyc/sandboxKycProvider.test.ts -> src/test-support/kyc/sandboxKycProvider.test.ts
RM src/lib/kyc/sandboxKycProvider.ts -> src/test-support/kyc/sandboxKycProvider.ts
RM src/lib/payments/sandboxPaymentProvider.test.ts -> src/test-support/payments/sandboxPaymentProvider.test.ts
RM src/lib/payments/sandboxPaymentProvider.ts -> src/test-support/payments/sandboxPaymentProvider.ts
 M vitest.postgres.config.ts
 M vitest.postgres.setup.ts
?? docs/remediation/CONTROL_ORDER_004-B_SV-007_FACTORY_TEST_CORRECTION.md
?? docs/remediation/Paid2You_Codex_Stage01_Final_Acceptance_Addendum.md
?? docs/remediation/Paid2You_Codex_Stage01_Final_Verification.md
?? docs/remediation/Paid2You_Codex_Stage02_Evidence_Addendum.md
?? docs/remediation/Paid2You_Codex_Stage02_Final_Acceptance_Addendum.md
?? docs/remediation/Paid2You_Codex_Stage02_Independent_Acceptance_Report.md
?? docs/remediation/STAGE_01_FINAL_IMPLEMENTATION_AND_EXIT_REPORT.md
?? docs/remediation/STAGE_02_008I_EXACT_ASSERTION_FIX.md
?? docs/remediation/STAGE_02_FINAL_PREAUTHORIZATION_CLARIFICATION.md
?? docs/remediation/STAGE_02_FOUR_FINDINGS_REMEDIATION_AND_GATE_B_READINESS.md
?? docs/remediation/STAGE_02_PHASE_A_ARCHITECTURE_AND_ISOLATION_REPORT.md
?? docs/remediation/STAGE_02_PHASE_B_ISOLATION_AND_HARNESS_EVIDENCE.md
?? docs/remediation/STAGE_02_PHASE_B_SUPPLEMENTAL_EVIDENCE_AND_AUTHORIZATION.md
?? docs/remediation/STAGE_02_PHASE_B_SUPPLEMENTAL_EXECUTION_REPORT.md
?? docs/remediation/STAGE_02_PHASE_C_008I_FINAL_FAILURE_DIAGNOSIS.md
?? docs/remediation/STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md
?? docs/remediation/STAGE_02_PHASE_C_FINAL_COMPLETION_REPORT.md
?? docs/remediation/STAGE_02_PHASE_C_REM008_POSTGRESQL_EXECUTION_REPORT.md
?? docs/remediation/STAGE_02_PHASE_C_TWO_FAILURES_REMEDIATION_AND_EXECUTION_READINESS.md
?? docs/remediation/STAGE_02_REPORTER_ONLY_CONFIGURATION_CHANGE.md
?? docs/remediation/STAGE_02_ROLE_OWNERSHIP_FINAL_CORRECTION_AND_PHASE_B_APPROVAL.md
?? docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md
?? scripts/check-no-adyen-dependency.mjs
?? scripts/check-no-adyen-dependency.test.mjs
?? scripts/check-no-sandbox-runtime.mjs
?? scripts/check-no-sandbox-runtime.test.mjs
?? src/db/schema/payoutAttempt.ts
?? src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts
?? src/lib/failedPayments/getPaymentRetryService.test.ts
?? src/lib/notify/consoleEmailSender.test.ts
?? src/lib/notify/consoleSmsSender.test.ts
?? src/lib/notify/getEmailSender.test.ts
?? src/lib/notify/getSmsSender.test.ts
?? src/lib/notify/productionFailClosed.test.ts
?? src/lib/payments/getPaymentWebhookService.test.ts
?? src/lib/payments/paymentInitiationEligibilityService.test.ts
?? src/lib/payouts/atomicPayoutConfirmer.ts
?? src/lib/payouts/atomicPayoutReturner.ts
?? src/lib/payouts/drizzlePayoutAttemptRepository.ts
?? src/lib/payouts/getPayoutService.ts
?? src/lib/payouts/payoutAttemptRepository.ts
?? src/lib/payouts/payoutService.ts
?? src/lib/payouts/testFakes.ts
?? src/test-support/payments/perKeyProviderCallCounter.test.ts
?? src/test-support/payments/perKeyProviderCallCounter.ts
?? test/postgres/outboundTransportGuard.mjs
?? test/postgres/outboundTransportGuard.test.mjs
```

Report byte size, SHA-256, and absolute path are verified after creation and supplied in the delivery message rather than embedding a self-referential hash.
