# Stage 2 — Two-Failures Remediation and Execution Readiness

**PAID2YOU — STAGE 2 FINAL TEST-FAILURE REMEDIATION ORDER**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: offline implementation only.
No Docker container was started. No PostgreSQL connection occurred. `--run-tests`/`npm run test:postgres` were not invoked. No production financial source, schema, migration, or provider integration was modified. No sibling worktree was accessed. No commit, push, merge, reset, stash, or branch change occurred. Generated: 2026-09-19.

---

## A. Baseline (ORDER 01)

**Directory:** `C:\Development\PAY2PAY-bank-v3`. **Branch:** `architecture/bank-managed-payments-v3`. **HEAD:** `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` — unchanged throughout, confirmed both before and after this round. **`git status --porcelain` line count:** 96 before this round's edits, 98 after (net +2: the two brand-new test-support files; no other file count changed).

**Files this round actually modified/created**, distinguished from every pre-existing Stage 2 modification:

| File | This round | Prior Stage 2 rounds |
|---|---|---|
| `src/lib/payments/paymentWebhookRecovery.postgres.test.ts` | Modified (TEST 008-I + R-B51 rewritten — Sections C/D) | Already modified (008-C/F/F-BLOCKED/G/H/I originally added, 008-H amended) |
| `src/test-support/payments/perKeyProviderCallCounter.ts` | **New** | — |
| `src/test-support/payments/perKeyProviderCallCounter.test.ts` | **New** | — |
| `scripts/postgres-test-db.mjs`, `scripts/postgres-test-db.test.mjs` | **Not touched this round** (shown modified vs. HEAD only because of prior rounds' work) | Modified in prior rounds (FIX 01/02/03, runtime-role verification, harmless scratch operation) |
| `vitest.postgres.config.ts` | **Not touched this round** — confirmed `git diff` empty, `include` reads `["src/**/*.postgres.test.ts"]` | Temporarily narrowed and reverted during the prior diagnostic round; confirmed still reverted |

**Confirmation that every temporary diagnostic edit from `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md` remains reverted:** `grep -c "008-I DIAGNOSTIC" src/lib/payments/paymentWebhookRecovery.postgres.test.ts` → `0` (re-confirmed at the start of this round, before any new edit). `vitest.postgres.config.ts`'s `include` reads the original full-suite pattern.

**Complete current implementations of TEST 008-I and R-B51, and their helpers/provider doubles, were read in full before any edit** — the exact pre-correction source is quoted verbatim in `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`, Sections A and B, and is not reproduced a second time here to avoid rewriting historical evidence; this report's Sections C and D quote only the corrected text.

**No sibling worktree was accessed** to investigate the earlier payout-file discrepancy, per this order's own instruction — Section F relies exclusively on evidence already gathered from within this worktree in the prior diagnostic round (`git ls-tree HEAD`, a full repository `find`).

---

## B. Source-level root causes (restated from the diagnosis, not re-derived)

| Defect | Root cause | Reference |
|---|---|---|
| `TEST 008-I` | A single global provider-call counter was inflated by an unrelated `claimed` retry, left behind by an earlier test in the same 150+-test shared-database file, incidentally swept up by `PaymentRetryService.fireDueRetries`'s own (correct, by-design) whole-table due-retry query. Not a production defect. | `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`, Section A |
| `R-B51` | The test exercises `applyPayoutRequired`/the `"payout.paid"` ledger-posting mechanism, which was deliberately removed by the "SC-05 — eliminate fictional payouts" architecture change; `"payout.paid"` is now explicitly handled as a safe no-op (`paymentWebhookService.ts:698-701`). Not a Stage 2 regression, not a flake. | `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`, Section B |
| `payoutService.postgres.test.ts` | The file does not exist in this worktree at all (confirmed via `git ls-tree HEAD` and a full repository `find`) — not a collection failure, not a config exclusion. The prior report's claim that it "exists on disk" was this agent's own error. | `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`, Section D |

## C. TEST 008-I — original failing assertion, minimal correction, before/after evidence

**Original failing assertion** (from the actual Phase C execution): `expect(attemptNumber).toBe(3)` — actual `4` — caused by a global `attemptNumber` counter incremented by every `createPayment` call the test's own provider Proxy received, regardless of which retry the call was actually for.

**Minimal correction:** replaced the global counter with `createPerKeyProviderCallCounter()` (new, pure, exported helper — `src/test-support/payments/perKeyProviderCallCounter.ts`), which tracks a running count **per idempotency key**. The test now:

1. Derives its own target key directly from its persisted fixture: `targetIdempotencyKey = \`retry-${failure.retryId}\`` — set only after `coordinator.coordinateFailure(...)` returns and the real `failure.retryId` is known, using the **exact** format `PaymentRetryService` itself constructs (`paymentRetryService.ts`'s own `idempotencyKey: \`retry-${retry.id}\`` at its claiming and resumption call sites) — never an invented or unrelated identifier.
2. On every `createPayment` invocation, records the call (`callCounter.record(request.idempotencyKey)`) **before** deciding what to do — so an unrelated key's call is never silently invisible; it is recorded and separately inspectable via `callCounter.keys()`/`callCounter.countFor(...)`.
3. If the invocation's key is **not** the target key, it is passed straight through to the real `SandboxPaymentProvider` — never forced through this test's own ambiguous-then-succeed script. This is the exact fix for "the provider double must not incorrectly process an unrelated retry merely because the target retry has reached its third expected call": the ambiguous-vs-succeed decision is now keyed strictly to the target's own count, never to a shared global tally an unrelated call could advance.
4. All three checkpoints now assert `callCounter.countFor(targetIdempotencyKey)` instead of the raw `attemptNumber`: `toBe(2)` after the initial claim+immediate-resumption pass, `toBe(2)` (unchanged) after the pre-eligibility scheduler run, `toBe(3)` after the post-eligibility scheduler run.

**`PaymentRetryService.fireDueRetries` was not modified, and its due-retry query was not restricted** — it still discovers and attempts to resolve every eligible claimed retry in the database, exactly as before; the correction is entirely confined to how the test's own double interprets and counts what it receives.

**Preserved, unchanged in substance:** the assertions proving the persisted backoff timestamp (`nextResolutionAttemptAt` within 2s of `t0 + AMBIGUOUS_RETRY_RESOLUTION_BACKOFF_MS`), no premature dispatch (`beforeEligible` leaves the count unchanged), stable execution token (`executionTokenAfterFirst` compared across firings), eventual recovery (`retryRow?.status === "fired"`), and absence of duplicate payment attempts (`listPaymentAttemptsForAgreement` length 1) — all retained verbatim, only their counter reference updated.

**New offline negative-test coverage** (`src/test-support/payments/perKeyProviderCallCounter.test.ts`, 7 tests, all passing — Section E): proves an unrelated key's invocations never affect the target key's count (the exact property this fix depends on), proves a duplicate invocation for the same key is still correctly detected/counted (never deduplicated away), plus `countFor` on an unrecorded key, `keys()` visibility, and independence between separate counter instances.

## D. R-B51 — replacement assertions and their mapping to current production code

| Original (obsolete) assertion | Depended on (removed) | Replacement assertion | Maps to (current, actual) source |
|---|---|---|---|
| `expect(attempt1.status).toBe("accepted")` | `applyPayoutRequired`'s synchronous ledger/audit write, which could fail and leave the event `"accepted"` | `expect(attempt1.status).toBe("processed")` | `applyEvent` returns immediately for an unrecognized type (`paymentWebhookService.ts:701`); `receiveWebhook`'s own success path (`:657-659`) then calls `markProcessed` and returns `{status: "processed"}` unconditionally, since nothing failed |
| `expect(payoutCompletedAt).not.toBeNull()` | The removed method's own `markPayoutCompleted` call | `expect(payoutCompletedAt).toBeNull()` | No code path reachable from a `"payout.paid"` event calls `markPayoutCompleted` any more; the field still exists on the schema (`payment.ts:42`) but is never set by this event |
| `expect(findAuditEventsByProviderEvent(..., "payment_webhook_payout.paid")).toHaveLength(0)` (asserted as the PRE-recovery state, expecting it to become `1` after retry) | The removed method's own one-time audit-write, deliberately made flaky | `expect(...).toHaveLength(0)` **permanently** (never expected to become 1) | The audit action this checks for is never written by any current code path for this event; asserting it stays empty is now the correct, permanent expectation |
| `recoverBatch(...)` + re-check for a restored audit record | Retry-recovery of the removed mechanism's one-time audit failure | Removed entirely | There is nothing left to recover — the event completed fully on its first attempt |
| `payoutEntries` (ledger `entryType === "payout"`) `toHaveLength(1)` | The removed method's own `LedgerService.postPayout` call | `toHaveLength(0)` | No payout ledger entry is ever posted by this event under the current architecture |

**New assertions added, not present in the original:** the payment's own full record is confirmed byte-for-byte unchanged across the no-op event (`expect(await ctx.payments.findById(payment.id)).toEqual(paymentAfterSuccess)`); the webhook event row itself is confirmed durably recorded and finalized (`eventRow?.processingStatus === "processed"`, `processedAt` non-null) — preserving "any legitimate webhook intake or generic processing record the current implementation is supposed to create," per this order's own instruction; and a redelivery of the identical event is confirmed to report `"duplicate"` (mirroring this same file's own pre-existing `B02` precedent for an already-processed event) and to still leave `payoutCompletedAt` null.

**`recordPayoutOwedRequired` was deliberately NOT introduced into this test** — direct source reading (`paymentWebhookService.ts:1515`) confirms it is invoked only from `payment.succeeded` processing, never from a `payout.paid` event; introducing it here would test a code path this event does not actually reach, which this order explicitly prohibits ("unless the source establishes that this specific event legitimately invokes it").

**No assertion conflict required stopping for an owner decision** — every original assertion could be either directly re-mapped to current, real behavior or correctly removed as testing a mechanism that provably no longer exists; no requirement had to be invented.

**Debtor-to-creditor direct-transfer / historical-payout separation:** unaffected by this correction — the rewritten test asserts only that a `"payout.paid"` webhook produces no payout-completion side effect of any kind, which is consistent with (and does not touch) the direct-transfer architecture or `recordPayoutOwedRequired`'s own separate, `pending`-only obligation-recording role.

## E. `payoutService.postgres.test.ts` — corrected, final disposition

**Confirmed, not re-investigated in a new way this round:** `git ls-tree HEAD -- src/lib/payouts/payoutService.postgres.test.ts` returns empty; a full-repository `find . -iname "payoutService.postgres*"` returns zero matches anywhere under this worktree. **The file is genuinely absent — no test-collection defect of any kind has been established, and none is claimed.**

**The earlier unsupported claim is retracted, not merely reworded:** the original Phase C execution report's statement that this file "exists on disk (27,736 bytes)" was incorrect; `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`, Section D, already identified and disclosed this as this agent's own error (most likely a working-directory mix-up with the separate, sibling `C:\development\pay2pay` checkout — not re-verified this round, since doing so would require crossing into that other directory, which remains out of scope).

**Actual discoverable PostgreSQL test file count in this worktree: 7** — `paymentWebhookRecovery.postgres.test.ts`, `installmentAmountAwareness.postgres.test.ts`, `settlementBinding.postgres.test.ts`, `signingConcurrency.postgres.test.ts`, `generalTermsRevisionConcurrency.postgres.test.ts`, `relationshipFinancialAccountService.postgres.test.ts`, `auditService.postgres.test.ts`. No eighth file is manufactured, imagined, or expected.

**`vitest.postgres.config.ts` confirmed at its original, full-suite `include` pattern** (`["src/**/*.postgres.test.ts"]`) — never left narrowed by the prior diagnostic round's temporary change, and not touched by this round at all.

**No new payout-service PostgreSQL test was created** to "correct" the earlier miscount, per this order's explicit instruction. **Genuine coverage gap, disclosed separately, not represented as a collection failure:** this worktree currently has no real-PostgreSQL test coverage at all for `src/lib/payouts/payoutService.ts`, `getPayoutService.ts`, `atomicPayoutConfirmer.ts`, or `atomicPayoutReturner.ts`. Whether such coverage is needed, and what it should assert against the current (not the removed) payout architecture, is a decision for the owner — not something this remediation round invents or attempts.

## F. Offline verification (ORDER 05)

**Diff inspected before any test execution** — confirmed the only substantive changes are: the two new files (Section A), and the two rewritten `it(...)` bodies inside `paymentWebhookRecovery.postgres.test.ts` (TEST 008-I, R-B51) plus one new import line. No other test, no production file, no schema, no migration, no configuration file was touched.

| Command | Purpose | Result |
|---|---|---|
| `npm run typecheck` | Full-repository static check, including both rewritten tests and the new helper | **0 errors**, exit 0 |
| `npm run lint` | Full-repository lint | **0 errors**, exit 0, 12 pre-existing warnings (identical set to every prior round) |
| `npx vitest run src/test-support/payments/perKeyProviderCallCounter.test.ts` | Focused verification of the new pure helper | **7/7 pass**, exit 0 |
| `npm run test:tooling` | Established offline harness/tooling suite | **170/170 pass**, exit 0 (unchanged from the prior round — nothing in this round touched harness code) |
| `npx vitest run` (full non-PostgreSQL regression suite) | Confirmed no database/external-service side effects before running (a plain Vitest run against `vitest.config.ts`, which excludes `*.postgres.test.ts` and touches no network/database) | **258/258 files, 2244/2244 tests pass**, exit 0 (up from 257/2237 — the one new file, 7 new tests) |

`npm run test:postgres` and `node scripts/postgres-test-db.mjs` (with or without `--run-tests`) were **NOT EXECUTED** this round — not authorized.

**Neither corrected test is declared PASS against real PostgreSQL.** Both `TEST 008-I` and `R-B51` compile, lint cleanly, and are structurally sound by inspection and by the passing offline coverage of their shared helper logic — but **neither has been run against a real database since this correction**, and this report does not claim otherwise. Both remain **NOT VERIFIED** until a future, separately authorized Phase C execution.

## G. Remaining Gate B and Phase C execution sequence (ORDER 06 — carried forward, not reinterpreted)

**Gate B supplemental requirements**, exactly as `STAGE_02_PHASE_B_SUPPLEMENTAL_EVIDENCE_AND_AUTHORIZATION.md` states them (not modified here):

- **Proposed command:** `node scripts/postgres-test-db.mjs` (no `--run-tests` — the existing, unchanged validation-only entry point).
- **Permitted effects:** create one new disposable container; verify container and in-database identity; bootstrap and verify the ownership marker; apply the unchanged migrations; create the `pay2pay_test_runtime` role and the `_pg_test_harness_scratch` fixture; **connect AS the runtime role** to verify its actual effective identity, `pg_roles` attributes (including the accepted `BYPASSRLS` exception), ownership-marker read-only protection, and representative application-table privileges; perform one harmless insert-observe-rollback-confirm operation against the scratch fixture only; remove its own container.
- **Not yet authorized or executed. Requires a new disposable container** — none of the runtime-role verification or harmless-scratch-operation code has been run against a real database at any point (confirmed in `STAGE_02_FINAL_PREAUTHORIZATION_CLARIFICATION.md`).
- **Required supplemental execution addendum**, once authorized and run, must include: actual `pg_roles` attribute values observed for the runtime role, the actual `has_table_privilege`/ownership query results for the marker table, the harmless scratch operation's actual insert/observe/rollback/post-rollback results, the run's exit code, and confirmation of exact-container cleanup.
- **Phase C must not proceed** until that supplemental evidence passes and the owner has explicitly acknowledged the completed Gate B — exactly as the Supplemental report's own authorization statement requires.

**Phase C, after Gate B is acknowledged:**

- **Proposed command:** `node scripts/postgres-test-db.mjs --run-tests` — its own fresh container, fresh run token, fresh identity/marker/role verification (Gate B's evidence does not carry over to a later, separately-provisioned container).
- **Required actual PostgreSQL PASS results, not offline/mocked substitutes:** 008-C, 008-F, 008-F-BLOCKED, 008-G, 008-H, and the **corrected** 008-I; the relevant concurrency/idempotency coverage already empirically reconfirmed once (`R-B40-STRICT-B`/`R-B40-STRICT-C`) must pass again.
- **Required: the complete real-PostgreSQL regression suite**, including the **corrected** R-B51, run without narrowing test collection (the full `["src/**/*.postgres.test.ts"]` include, exactly as confirmed in Section E — never re-narrowed to a single file as the prior diagnostic round did temporarily).
- **Independent Codex review is mandatory** after a successful Claude-executed Phase C report, per the Stage 2 master order's own Phase D structure. **Claude cannot approve Stage 2 or initiate Stage 3** — both remain exclusively owner/Codex-gated decisions this or any prior Claude-authored report does not and cannot substitute for.

## H. Report verification

File path: `docs/remediation/STAGE_02_PHASE_C_TWO_FAILURES_REMEDIATION_AND_EXECUTION_READINESS.md`. Byte size and SHA-256 are recorded in the confirmation step immediately following this file's creation (see the chat response), not asserted in advance of that check.

This report is not an authorization for the supplemental Gate B command or for `--run-tests`/Phase C — both remain exactly as unauthorized as they were before this round, pending the owner's own separate decision.

*End of report.*
