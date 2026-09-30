# Stage 2 — Phase C Failure Diagnosis

**PAID2YOU — STAGE 2 PHASE C FAILURE DIAGNOSIS (diagnostic-only authorization)**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: diagnosis only — no fix implemented.
All three disposable containers used below were created and destroyed by the established harness (`node scripts/postgres-test-db.mjs --run-tests`). No production, hosted, development, or shared database was accessed. No real provider was contacted. **No production code, migration, test assertion, expected value, or acceptance criterion was changed.** Two temporary diagnostic modifications were made and fully reverted before this report was written (Section E). No commit, push, merge, or deployment occurred. Generated: 2026-09-19.

---

## Executive summary

| Defect | Root cause | Nature |
|---|---|---|
| `TEST 008-I` — 4 dispatches instead of 3 | The test's own shared `attemptNumber` counter is incremented by an **unrelated retry row left behind by an earlier test in the same shared-database file**, which the test's own `fireDueRetries` call incidentally sweeps up alongside its own retry. **Not a production defect.** | Deterministic given the shared-database ordering; a genuine test-isolation defect in the new test itself |
| `R-B51` — `expected 'processed' to be 'accepted'` | The test sends a `"payout.paid"` webhook event, expecting the **old, deliberately removed** `applyPayoutRequired` mechanism. That mechanism was intentionally deleted as part of the "SC-05 — eliminate fictional payouts" architecture change; `"payout.paid"` is now explicitly handled as a safe no-op (`paymentWebhookService.ts:698-701`). **Not a Stage 2 regression, not flaky — R-B51 tests functionality that no longer exists.** | 100% deterministic; a stale test for superseded architecture |
| `payoutService.postgres.test.ts` did not run | **The file does not exist in this worktree.** Confirmed via `git ls-tree HEAD` (empty) and a full repository `find` (zero matches). Its earlier "27,736 bytes" claim in the prior Phase C report was **my own error** — see Section D.3 for the correction. | Not a harness, config, or Vitest defect at all |

---

## A. `TEST 008-I` — exact root cause

**Affected file/function:** `src/lib/payments/paymentWebhookRecovery.postgres.test.ts`, the `TEST 008-I` test body (its own local `provider` Proxy wrapping `createPayment`), interacting with the **production** `PaymentRetryService.fireDueRetries` (`src/lib/failedPayments/paymentRetryService.ts:390`) and its `findClaimedForResumption`-driven resumption loop (`:489-506`).

**Trace, using the retry ID/idempotency key/execution token/provider-call-count evidence captured across three independent reproductions (Section C):**

1. `fireDueRetries(t0)` — call #1 (idempotency key `retry-<MY-retryId>`): the initial claim dispatch. Ambiguous (by design). Call #2 (same key): the same `fireDueRetries` call's own immediate resumption pass, since `nextResolutionAttemptAt` is still `NULL` immediately after a fresh claim. Also ambiguous, and this is what sets a real `nextResolutionAttemptAt` via `markResolutionDeferred`. **Confirmed correct in all 3 runs** — the test's own assertion `expect(attemptNumber).toBe(2)` here passed every time.
2. `fireDueRetries(beforeEligible)` — zero calls, confirmed correct in all 3 runs (`attemptNumber` stayed 2).
3. `fireDueRetries(afterEligible)` — **call #3 carries a idempotency key belonging to a DIFFERENT retry than the test's own** (confirmed in all three runs: run 1 `retry-4fa88ed7-...` vs. the test's own `retry-b4866702-...`; run 2 `retry-01c7f8bf-...` vs. `retry-43b32b75-...`; run 3 `retry-f30e6402-...` vs. `retry-0201a33a-...`). Call #4, immediately after, carries the test's OWN idempotency key and is the dispatch the test actually intended to count as "the third."

**Root cause, precisely stated:** `PaymentRetryService.fireDueRetries`'s resumption phase (`findClaimedForResumption(limit, now)`) queries the **entire, shared `payment_retry` table** for any row with `status = 'claimed'` and a due `nextResolutionAttemptAt` — it is a scheduler-style method with no concept of "which test's fixtures" a row belongs to, by design (this is correct, intended production behavior — a real scheduler must sweep every due row, not just some subset). `paymentWebhookRecovery.postgres.test.ts` runs 157+ tests sequentially against **one shared, non-transactional, non-rolled-back real PostgreSQL database** (confirmed by this file's own extensive prior doc comments, and explicitly acknowledged in `R-B51`'s own comment: *"this shared-database suite's batch call may also sweep up unrelated due leftovers"*). Some earlier test in the same file leaves behind a `claimed`, still-ambiguous retry row with `nextResolutionAttemptAt` either `NULL` or due before `afterEligible` (`t0 + 15min + ~1s`) is reached. `TEST 008-I`'s own `fireDueRetries(afterEligible)` call — using the test's own `provider` Proxy, since that Proxy is what `retryService` was constructed with — incidentally dispatches to **that unrelated row too**, incrementing the test's shared `attemptNumber` counter to 4 instead of the 3 the test's own scenario alone would produce.

**This is not a production defect.** `fireDueRetries` behaved exactly as designed: it found every genuinely due `claimed` row and attempted to resolve each one, exactly once, using the caller-supplied `provider`. The defect is entirely in `TEST 008-I` itself: it counts **every** invocation of its own provider Proxy, without scoping that count to its own retry's idempotency key, in a test suite whose own architecture explicitly does not isolate one test's `payment_retry` rows from another's scheduler sweeps.

**Which earlier test leaves the dangling row was not pinpointed within this diagnostic round's scope** (157 preceding tests would each need individual inspection for a residual `claimed`+`NULL`-or-soon-due row at their own conclusion). This is disclosed as an unresolved sub-question, not fabricated. It does not weaken the root-cause finding above, which is independently and conclusively established by the idempotency-key mismatch evidence itself, reproduced identically in structure across three independent runs.

## B. `R-B51` — exact root cause

**Affected file/function:** `src/lib/payments/paymentWebhookRecovery.postgres.test.ts:1444` (`TEST R-B51`), exercising `PaymentWebhookService.applyEvent` (`src/lib/payments/paymentWebhookService.ts:687-701`).

**Exact assertion failure:** `expect(attempt1.status).toBe("accepted")` (line 1486) — actual value `"processed"`.

**Root cause, confirmed by direct source reading, not inference:** `paymentWebhookService.ts:692-701`, read in full:
> *"PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-05 — eliminate fictional payouts): `"payout.paid"` was previously special-cased here and dispatched to a since-REMOVED `applyPayoutRequired` method that marked a payout complete from the bare arrival of this one event type — with no live payout provider ever having been called... It is now handled exactly like any other genuinely unrecognized event type: a safe no-op, never a completion."*
>
> `const isRecognizedEventType = eventType in EVENT_TYPE_TO_STATUS; if (!isRecognizedEventType) return;` (lines 700-701)

`R-B51` sends a `"payout.paid"` webhook event and expects it to be processed via the old `applyPayoutRequired` mechanism — posting a ledger `payout` entry, setting `payoutCompletedAt`, and writing a `"payment_webhook_payout.paid"` audit record whose injected one-time failure (`flaky(..., "record", 1, ...)`) the test expects to observe as an `"accepted"` (not-yet-processed) intermediate state. **That entire mechanism no longer exists.** `applyEvent` now returns immediately for `"payout.paid"` (`return;` at line 701) — the audit-write injection point the test's `flaky()` wrapper is aimed at is **never reached at all**, so the webhook simply completes with nothing left to do, and the claim/process pipeline marks it `"processed"` immediately, matching the exact observed value.

**Deterministic, environment-independent, and not caused by any Stage 2 change.** This is not timing-sensitive, not affected by database state, and does not depend on anything this engagement modified — `paymentWebhookService.ts` was never touched by any Stage 2 order. `R-B51` is defined at line ~1444, **before** every one of this engagement's new tests (inserted after line ~2551), so no Stage 2 test could have polluted shared state ahead of it. The comment at `paymentWebhookService.ts:692` shows this architectural removal (SC-05) predates this entire Stage 2 engagement — `R-B51` was written for, and never re-validated against, the architecture that existed *before* SC-05. This is a stale test for superseded production functionality, not a flake and not a regression.

## C. Reproduction commands and results (3 independent runs)

Each run used `node scripts/postgres-test-db.mjs --run-tests`, producing its own freshly generated disposable container (name, run token, and port all unique per run — confirmed from each run's own startup log line), with `vitest.postgres.config.ts`'s `include` **temporarily** narrowed to `paymentWebhookRecovery.postgres.test.ts` alone (Section E) purely to shorten iteration time; this does not change what the test itself does or asserts.

| Run | Container | Result | 008-I call #3 idempotency key (unrelated to the test's own `retry-<id>`) |
|---|---|---|---|
| 1 | `pay2pay-pgtest-*` (run 1) | `Tests: 2 failed \| 155 passed (157)` | `retry-4fa88ed7-7549-4a8a-8dc6-eb826974dea0` (test's own: `retry-b4866702-...`) |
| 2 | `pay2pay-pgtest-26268-d9dff571` | `Tests: 2 failed \| 155 passed (157)` | `retry-01c7f8bf-94ff-453d-b1e6-151a62046962` (test's own: `retry-43b32b75-...`) |
| 3 | `pay2pay-pgtest-*` (run 3) | `Tests: 2 failed \| 155 passed (157)` | `retry-f30e6402-87e3-4b55-be88-2519ef401315` (test's own: `retry-0201a33a-...`) |

**Identical result in all three runs**: exactly `TEST 008-I` and `R-B51` fail, with the identical assertion text each time (`R-B51`: `expected 'processed' to be 'accepted'` at line 1486; `008-I`: `expected 4 to be 3` at what was line 2874 before/after the temporary logging). No other test failed in any run. All three containers were confirmed removed after their run (`docker ps -a --filter "label=pay2pay-test-harness=true"` returned zero rows after each).

## D. `payoutService.postgres.test.ts` — exact root cause and correction of a prior error

**Investigation performed:**
```
git ls-tree HEAD -- src/lib/payouts/payoutService.postgres.test.ts     → (empty — not tracked at HEAD)
find . -iname "payoutService.postgres*" -not -path "*/node_modules/*"  → (zero matches, anywhere in the repository)
git log --all --name-status -- src/lib/payouts/payoutService.postgres.test.ts
  → shown as Added/Modified only in commits (2de1f72, c333cb1, 2eccea4, b0d59aa) that are NOT
    ancestors of this worktree's current HEAD (93bbbbf8...) — they exist only on other refs.
ls -la src/lib/payouts/   → payoutService.ts, testFakes.ts, getPayoutService.ts,
                             atomicPayoutConfirmer.ts, atomicPayoutReturner.ts,
                             drizzlePayoutAttemptRepository.ts, payoutAttemptRepository.ts —
                             no .postgres.test.ts file of any kind.
```

**Conclusion: the file does not exist in this worktree, on this branch, at this HEAD.** It was never excluded by configuration, never failed collection, and was never silently skipped — `vitest.postgres.config.ts`'s `include: ["src/**/*.postgres.test.ts"]` glob correctly matched every `.postgres.test.ts` file that actually exists (7 of them), and there is no 8th file for it to have missed.

**Correction of a prior claim, disclosed rather than left standing:** the immediately preceding Phase C execution report (`STAGE_02_PHASE_C_REM008_POSTGRESQL_EXECUTION_REPORT.md`) stated this file "exists on disk (27,736 bytes)" and described its non-execution as an "anomaly requiring separate investigation." **That claim was incorrect.** The most likely explanation, consistent with this session's own observed Bash-tool behavior (several commands in this and prior turns were followed by an explicit `Shell cwd was reset to C:\development\pay2pay` notice — the **lowercase**, original `PAY2PAY` checkout, a **different repository directory** from this worktree, `C:\Development\PAY2PAY-bank-v3`), is that the earlier `ls -la src/lib/payouts/payoutService.postgres.test.ts` check was executed with its working directory silently reset to that other checkout — which this session's very first git-status context confirms is on branch `remediation/08-authorization-tenant-isolation`, with its own distinct payout-related commit history — rather than against this V3 worktree at all. This diagnostic round did not cross into that other directory to confirm this mechanism precisely (doing so would itself violate this engagement's standing, repeatedly-stated restriction against accessing any path outside the authorized V3 root, which this order's own silence on the point does not lift); the correction stands on its own direct evidence (Section D's git/filesystem checks against the actual V3 worktree), independent of confirming exactly how the earlier error occurred.

## E. Temporary diagnostic modifications (both fully reverted before this report)

1. `vitest.postgres.config.ts` — `include` temporarily narrowed to `["src/lib/payments/paymentWebhookRecovery.postgres.test.ts"]` to shorten each reproduction run from ~90s to ~50s. **Reverted** to `["src/**/*.postgres.test.ts"]`; confirmed via `git diff -- vitest.postgres.config.ts` returning empty.
2. `paymentWebhookRecovery.postgres.test.ts` — a temporary `console.error` inside `TEST 008-I`'s own provider Proxy, logging the call number, the idempotency key of each `createPayment` invocation, and a stack trace. **Reverted**; confirmed via `grep -c "008-I DIAGNOSTIC"` returning `0`.

Post-revert: `npm run typecheck` → 0 errors; `npm run lint` → 0 errors, the same 12 pre-existing warnings. No test assertion, expected value, production file, or migration was touched at any point in this diagnostic round. `git rev-parse HEAD` unchanged (`93bbbbf8950010d4c0a70c7133339dc352ebd0fd`) throughout.

## F. Minimal proposed corrections (NOT implemented this round)

**For `TEST 008-I`:** scope the dispatch counter to the test's own idempotency key, e.g. replace the shared `attemptNumber` counter with a per-key count (`const attemptsByKey = new Map<string, number>()`, incremented inside the Proxy keyed off `args[0].idempotencyKey`), and assert on `attemptsByKey.get(myIdempotencyKey)` at each checkpoint instead of a raw global count — mirroring exactly how `R-B51` itself already defends against this same shared-database property (`toBeGreaterThanOrEqual(1)` instead of strict equality, with an explicit comment acknowledging why). This requires no database, schema, or production-code change — it is confined to the test file's own local counting logic.

**For `R-B51`:** this is a decision for the owner, not a code-level "correction" this report can respond to unilaterally — the test currently validates functionality that was intentionally removed. Two honest options exist: (a) retire/delete the test, since `applyPayoutRequired`/the `"payout.paid"` ledger-posting mechanism no longer exists in production and cannot be "fixed" without reintroducing exactly the "fictional payouts" architecture SC-05 deliberately eliminated; or (b) rewrite it to test the **current** payout architecture (`recordPayoutOwedRequired`, triggered by `payment.succeeded` itself, recording a `pending` payout obligation via `PayoutService.recordPayoutOwed` — never a completed/confirmed payout, since no live provider integration exists). Neither option is implemented here, per this order's explicit "do not fix anything" instruction; this is reported as a required owner decision, not a defect this diagnostic round can resolve by itself.

**For `payoutService.postgres.test.ts`:** no correction is proposed — there is no defect to correct. If payout-specific real-PostgreSQL coverage is desired in this worktree, that would be a **new** test-authoring task (potentially informed by whatever exists on the other branch/ref this file's git history shows), not a fix to an existing broken file.

## G. Required tests proving each correction (for a future, separately authorized round)

- **008-I:** a test proving the per-key counting approach itself is correct — e.g., an offline or isolated-fixture test asserting that the corrected counter only increments for the test's own idempotency key even when a second, unrelated `createPayment` call (simulating another swept-up row) occurs on the same provider Proxy with a different key.
- **R-B51 (if retired):** no new test — its removal would need to be justified by confirming (via a repository-wide search, already partially done in Section B) that no other test independently covers the `payoutCompletedAt`/ledger-`payout`-entry assertions this test currently makes, or that those assertions are already meaningless post-SC-05.
- **R-B51 (if rewritten):** a new test exercising `recordPayoutOwedRequired`'s actual real-PostgreSQL behavior — asserting a `payout_attempt` row (or equivalent) is created in `"pending"` status upon `payment.succeeded`, and that `PayoutService.confirmPayout`'s own separate, `PAYOUT_PROVIDER_INTEGRATION_VERIFIED`-gated flag still fails closed absent a live provider integration — mirroring this engagement's own SV-006/SV-007 pattern of testing the actual current authorization boundary, not a superseded one.
- **`payoutService.postgres.test.ts`:** not applicable — no correction, no new test required by this diagnostic round.

## H. Explicit stop conditions — none required

Every root cause in this report is proven, not merely suspected: `008-I`'s extra dispatch is proven by direct idempotency-key evidence captured identically across three independent real-PostgreSQL runs; `R-B51`'s failure is proven by direct citation of the exact, current, in-repository source code and comment explaining the intentional removal; `payoutService.postgres.test.ts`'s non-execution is proven by `git ls-tree`/`find` showing the file's genuine absence from this worktree. No root cause in this report remains unproven or requires further escalation before a correction could be authorized. The only open, disclosed sub-question — which specific earlier test leaves the dangling retry row `008-I` sweeps up — does not block proposing or implementing Section F's correction, since that correction (scoping the counter to the test's own key) is correct regardless of which other test is the source.

## I. Stage boundary

This report diagnoses; it does not fix, and does not declare Stage 2 complete. No commit, push, merge, or deployment occurred. No further phase was begun.

*End of report.*
