# Paid2You Stage 2 Final Independent Acceptance Addendum

**Auditor:** Codex  
**Date:** 2026-09-20  
**Disposition:** INDEPENDENTLY ACCEPTED; ready for the Project Owner's final approval.

## Scope and repository verification

Before each shell invocation, the working directory was explicitly set to `C:\Development\PAY2PAY-bank-v3`. The actual working directory and Git root matched that repository. Branch `architecture/bank-managed-payments-v3` and HEAD `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` matched the order. Root AGENTS.md and CLAUDE.md were read; no additional AGENTS.md was found under docs. The master specification was read during the preceding audit work. The user's explicit authorization to inspect the specified external evidence directory governs that access. The sibling checkout was not accessed.

The existing independent acceptance report and evidence addendum were reread. Existing staged, unstaged, and untracked work was preserved. This report supersedes their blocked disposition without modifying either historical report.

## Evidence identity and correlation

Only this execution bundle was used to close the outstanding requirements:

`C:\Users\solod\OneDrive\Desktop\Paid2You_Stage02_Evidence_20260920_171354_3ee0482a`

References below use original file line numbers, starting at 1. ANSI color sequences were removed only in memory for inspection; evidence files were not modified.

- `00-preflight.txt:1-7` records the authorized root, matching branch/HEAD, intended command, and no pre-existing harness-labeled containers.
- `03-exit-status.txt:1-5` records `node scripts/postgres-test-db.mjs --run-tests`, start `2026-09-20T17:13:54.1912135-04:00`, end `2026-09-20T17:15:58.2380515-04:00`, captured Node process exit code **0**, and no launch/wait error.
- `01-postgres-stdout.log:1-9` identifies generated container `pay2pay-pgtest-12408-85416b6e`, image `postgres:17-alpine`, run token `65edeeb0-9ac4-44dc-975c-cf3c6684f07b`, loopback port `63041`, confirmed container identity, database identity, and ownership marker.
- Stdout lines 263-279 record successful migrations, runtime-role checks, scratch rollback, and PostgreSQL suite execution. Line 281 identifies Vitest v3.2.7 and the authorized repository.
- Stdout lines 567-568 record test start `17:13:58` and duration `118.21s`, consistent with the harness interval. Stderr timestamps include `21:14:00.890Z` and `21:15:43.770Z`, consistent with that interval at UTC-04:00; stderr line 370 identifies Node PID 12408.
- Stdout line 570 names the same container for cleanup. The separate cleanup verification at `2026-09-20T17:15:58.4286091-04:00` follows harness completion and names that exact container.

The records consistently identify one execution. This is the 17:13 run authorized by this order, not the earlier screenshot run with container `pay2pay-pgtest-10148-ef6ec296`. No evidence from those runs was combined to infer exit status or cleanup.

## Acceptance evidence matrix

| Requirement | Independently inspected evidence | Result |
|---|---|---|
| All PostgreSQL files/tests pass | Stdout 283-563: 281 individual PASS rows; 565: `7 passed (7)`; 566: `281 passed (281)` | PASS: 281 tests, 7 files; zero failed tests/files |
| Actual harness process exit | Exit-status file 1-5 explicitly records captured Node exit code 0, command, timestamps, and no launch/wait error | RESOLVED |
| Generated container removed | Cleanup file 2-3, 6-8: exact generated name; all-container listing exit 0; exact-name presence False; completed cleanup True | RESOLVED |
| No harness-labeled containers remain | Cleanup file 4-5: label-filter listing exit 0; remaining containers `(none)` | RESOLVED |
| Seven explicit named PASS results | Original stdout lines listed below, each with genuine Vitest U+2713 PASS marker | RESOLVED |
| Evidence integrity | All seven recorded SHA-256 values and byte counts independently recomputed and matched | PASS |

Exit status comes from the captured process record, not a prompt or test summary. Completed cleanup comes from the successful Docker verification records, not the cleanup announcement. No Docker command was executed during this audit.

### Seven-file reconciliation

All paths below are under `src/lib/`. Counts were independently obtained from individual passing runtime rows, not copied from the evidence summary.

| PostgreSQL test file | Original stdout lines | Passing tests |
|---|---:|---:|
| payments/paymentWebhookRecovery.postgres.test.ts | 283-439 | 157 |
| ledger/installmentAmountAwareness.postgres.test.ts | 440-528 | 89 |
| agreements/signingConcurrency.postgres.test.ts | 529-539 | 11 |
| settlements/settlementBinding.postgres.test.ts | 540-553 | 14 |
| relationships/relationshipFinancialAccountService.postgres.test.ts | 554-557 | 4 |
| agreements/generalTermsRevisionConcurrency.postgres.test.ts | 558-560 | 3 |
| audit/auditService.postgres.test.ts | 561-563 | 3 |
| **Total** | **283-563** | **281** |

The individual counts agree with both aggregate totals. No leading Vitest FAIL, cross, or multiplication-sign failure row was found in stdout.

## Seven named runtime results

Every row below is from `01-postgres-stdout.log`, in `src/lib/payments/paymentWebhookRecovery.postgres.test.ts > R06 + R09: payment/webhook recovery integrity (real Postgres)`. Each contains its exact named identity, a green ANSI-wrapped `✓` (U+2713), and an elapsed duration. Descriptions here summarize the original full result lines.

| Exact identity | Original line | Runtime behavior | PASS duration |
|---|---:|---|---:|
| TEST 008-C | 333 | Flag true; otherwise-authorized retry calls provider exactly once and fires | 548ms |
| TEST 008-F | 335 | Genuine not-found redispatch; same idempotency key; persisted result; repetition does not duplicate | 232ms |
| TEST 008-F-BLOCKED | 336 | Flag false refuses redispatch, preserves recoverability, makes zero calls; later authorized resolution remains possible | 273ms |
| TEST 008-G | 337 | Historical webhook status/ledger update succeeds while new retry dispatch is blocked | 352ms |
| TEST 008-H/I | 334 | Disabled coordinator preserves claim/state; repeated disabled firing creates no call or duplicate attempt | 917ms |
| TEST 008-I | 338 | Real backoff; no premature scheduler resumption; later settlement with stable fencing and no duplicate dispatch | 350ms |
| R-B51 | 314 | payout.paid safe no-op; no payout completion/ledger/audit effect; durable receipt and finalization exactly once | 274ms |

TEST 008-F and TEST 008-F-BLOCKED were verified as distinct complete identities on separate original lines. TEST 008-H/I was likewise not substituted for TEST 008-I. The earlier failed 008-I and R-B51 execution remains historical; this execution provides explicit passing runtime evidence for both.

## Named-test detector false-negative diagnosis

`05-named-test-results.txt` labels all seven cases `NAMED PASS LINE NOT OBSERVED` on lines 2, 4, 6, 8, 10, 12, and 14, while reproducing the corresponding runtime lines immediately below. Its derived summary, `06-evidence-summary.txt:5,7`, therefore reports False.

The raw stdout is UTF-8 without a BOM. The original PASS marker is bytes `E2 9C 93`, wrapped in ANSI green/reset sequences. Explicit UTF-8 decoding produces U+2713 (`✓`). In the inspected Windows PowerShell 5.1 environment, default text decoding uses Windows-1252 and turns those bytes into U+00E2 U+0153 U+201C (`âœ“`). The em dash is similarly corrupted.

A read-only reproduction removed ANSI sequences in memory and compared explicit UTF-8 decoding with default Get-Content decoding for all seven original lines:

- Correct UTF-8: seven of seven match a leading U+2713 PASS-indicator check.
- Default decoding: zero of seven match that same check.
- Each default-decoded, ANSI-stripped line exactly equals the corresponding reproduced line in the named-test report.

Thus ASCII case-name detection can find and reproduce each line while a Unicode checkmark test rejects its corrupted marker. This is a confirmed evidence-reporting false negative, not a failed PostgreSQL test. The raw PASS markers and exact identities are intact. The summary's False gate value does not override the original execution evidence.

**Script-inspection boundary:** No evidence-wrapper script is included among the bundle's eight files, and no matching script was found in the repository scripts/docs, repository PowerShell-file listing, or directly on the Desktop. Its location was requested. The exact original detector source and regex could not be inspected; no claim is made that its precise implementation was read. The decoding failure and generated output were independently reproduced as described above. This provenance limitation does not negate the independently verified named-test results or create a new Stage 2 gate. No script was changed or executed.

## Hash verification

Each following current byte count and SHA-256 matches its entry in `07-file-hashes.txt`.

| File | Bytes | SHA-256 | Result |
|---|---:|---|---|
| 00-preflight.txt | 382 | 36ADC20225448B584C87A385FB11CB6DA2A0088E48A070E372A480ECFC4FE86D | MATCH |
| 01-postgres-stdout.log | 138224 | C6556943D2361828A2832E533C463414BC0682EDE235BD203C9DB7FBC21100C1 | MATCH |
| 02-postgres-stderr.log | 92772 | A87B0796630AE3A32C8BB7D6918D2B94738B3639C2ADFF29CD633105CEC9BEE6 | MATCH |
| 03-exit-status.txt | 202 | 68981BB735B949810F96AD8BA20FF7D5777B7733C37AC8700B4F16C69823A3E3 | MATCH |
| 04-docker-cleanup.txt | 496 | 6254ABC62EA30CCDF0E64CFB85125CAAE38804AB1C970369C6DE9EC13BC1E4A1 | MATCH |
| 05-named-test-results.txt | 3404 | 109174FCF73A06BEB1DDB3159313984AA07AF6302893234E51B61C6B0F4ED20C | MATCH |
| 06-evidence-summary.txt | 573 | 0057A3B5C491657FA296E5D31439657086384B1DF9751ADA03CC51AC7B38BC01 | MATCH |

The manifest itself is 772 bytes; its current SHA-256 is `B4957A7CEA3E12B6F1C397181F8632DA135C012DC3EC397C92236AB9C29C6D66`. It has no recorded self-hash, so this is a newly calculated fingerprint, not a claimed self-hash match. Matching hashes establish consistency with the supplied manifest, not independent cryptographic attestation of provenance.

## Outstanding limitations and final disposition

Previously disclosed limitations remain: the owner-accepted BYPASSRLS exception does not prove RLS enforcement; the outbound guard is process-level rather than OS-level; PostgreSQL payout-service coverage is absent. The Node DEP0190 warning remains visible. None is newly demonstrated by this review to violate an unmet Stage 2 acceptance requirement. The detector reporting defect is separate from application behavior and requires no application correction for acceptance.

The earlier screenshot-verified non-PostgreSQL result remains 2,244/2,244 tests across 258 files; it was not rerun or represented as part of this PostgreSQL execution.

**All three original evidence blockers are resolved: captured process exit code, completed container cleanup, and explicit named runtime PASS results. No Stage 2 acceptance blocker remains. Codex independently accepts Stage 2 as ready for the Project Owner's final approval. Final owner acceptance remains exclusively with the Project Owner.**

Only this new report was created. Application code, tests, configuration, migrations, existing reports, and evidence were not modified. No Docker, PostgreSQL, test-suite, provider, deployment, staging, commit, push, merge, or Stage 3 operation was performed.
