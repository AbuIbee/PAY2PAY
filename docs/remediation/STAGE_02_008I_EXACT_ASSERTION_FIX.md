# Stage 2 — TEST 008-I Exact Assertion Fix

**PAID2YOU — FIX 008-I NOW: DIRECTORY RECOVERY + EXACT ASSERTION CORRECTION**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: offline test-only correction and verification. No Docker, no PostgreSQL connection, no `--run-tests`, no financial-suite execution, and no sibling-worktree access occurred in the course of this order. Generated: 2026-09-20.

---

## A. Working-directory recovery (ORDER 1)

The shell tool's ambient working directory continues to reset to `C:\development\pay2pay` between invocations (a known tool-environment behavior, confirmed again this round). Per this order's explicit authorization, every PowerShell invocation in this round began with:

```powershell
Set-Location -LiteralPath "C:\Development\PAY2PAY-bank-v3"
if ((Get-Location).Path -ine "C:\Development\PAY2PAY-bank-v3") { throw "AUTHORIZED WORKTREE MISMATCH" }
```

Every such check passed. Repository identity, verified in the first invocation:
- Working directory: `C:\Development\PAY2PAY-bank-v3` (confirmed via `Get-Location`, not merely `git -C`)
- Repository root: `C:/Development/PAY2PAY-bank-v3`
- Branch: `architecture/bank-managed-payments-v3`
- HEAD: `93bbbbf8950010d4c0a70c7133339dc352ebd0fd`

All match the required values. `C:\development\pay2pay` was never listed, read, or otherwise inspected — only its path string appeared in the shell's own post-command cwd-reset notices.

## B. Exact change made

**File:** `src/lib/payments/paymentWebhookRecovery.postgres.test.ts` — TEST 008-I only (the `it(...)` block starting at line 2819). No other test, and no production file, was modified.

**Removed** (the final comment + assertion):
```ts
    // No duplicate payment_attempt row was ever created for OUR agreement across the whole sequence
    // (an unrelated retry belongs to a different agreement entirely, so this remains a precise check).
    expect(await listPaymentAttemptsForAgreement(agreementId)).toHaveLength(1);
```

**Replaced with** (immediately after the existing `expect(retryRow?.status).toBe("fired")` check, unchanged):
```ts
    // STAGE 2 PHASE C 008-I ASSERTION CORRECTION (docs/remediation/STAGE_02_PHASE_C_008I_FINAL_FAILURE_DIAGNOSIS.md
    // and docs/remediation/STAGE_02_008I_EXACT_ASSERTION_FIX.md): the previous `toHaveLength(1)` here
    // was simply wrong — it silently counted the pre-existing ORIGINAL attempt (`payment.id`, seeded
    // above, before any failure/retry activity) together with the retry's own anchor as if only one
    // row could legitimately exist. Two rows are legitimately expected for this agreement:
    // `payment.id` (the original attempt this whole sequence started from) and the retry's own single
    // dispatch anchor, durably recorded on the retry row as `resultingPaymentAttemptId`
    // (`establishDurableDispatchIntent`, failedPaymentRetryCoordinator.ts:1689/1722) — created exactly
    // once, guarded by an idempotency-key existence check inside the SAME transaction that inserts it,
    // and only ever UPDATED (never re-inserted) by every later ambiguous-resumption/resolution call.
    // The assertions below prove the intended invariant precisely — exactly these two identified rows,
    // never a third, never a second anchor, and the original left untouched — rather than merely
    // asserting a bare count that happens to match for the wrong reason.
    const resultingPaymentAttemptId = retryRow?.resultingPaymentAttemptId ?? null;
    expect(resultingPaymentAttemptId).not.toBeNull();
    expect(resultingPaymentAttemptId).not.toBe(payment.id);

    const attemptsForAgreement = await listPaymentAttemptsForAgreement(agreementId);
    expect(attemptsForAgreement).toHaveLength(2);
    expect(attemptsForAgreement.map((row) => row.id).sort()).toEqual([payment.id, resultingPaymentAttemptId].sort());

    // Exactly one of the two rows carries the retry's own idempotency key, and it IS the identified
    // anchor — never the original attempt's own (unrelated, randomly-generated) idempotency key.
    const rowsWithRetryKey = attemptsForAgreement.filter((row) => row.idempotencyKey === targetIdempotencyKey);
    expect(rowsWithRetryKey).toHaveLength(1);
    expect(rowsWithRetryKey[0]?.id).toBe(resultingPaymentAttemptId);

    // The original attempt itself was never mutated by the recovery sequence — the retry created and
    // resolved its OWN separate row throughout, never touching this one.
    const originalAfterRecovery = attemptsForAgreement.find((row) => row.id === payment.id);
    expect(originalAfterRecovery).toEqual(payment);
```

## C. How each requirement in ORDER 2 is satisfied

| Requirement | Where satisfied |
|---|---|
| Retrieve the retry's persisted `resultingPaymentAttemptId` and require non-null | `const resultingPaymentAttemptId = retryRow?.resultingPaymentAttemptId ?? null; expect(resultingPaymentAttemptId).not.toBeNull();` — `retryRow` was already re-fetched from `listRetriesForInstallment` immediately above, after the retry reached `"fired"` |
| Exactly two rows for the agreement | `expect(attemptsForAgreement).toHaveLength(2);` |
| IDs are exactly `payment.id` and `resultingPaymentAttemptId`, and they are distinct | `expect(attemptsForAgreement.map((row) => row.id).sort()).toEqual([payment.id, resultingPaymentAttemptId].sort());` plus `expect(resultingPaymentAttemptId).not.toBe(payment.id);` |
| Exactly one row carries `retry-${failure.retryId}` and its ID equals `resultingPaymentAttemptId` | `targetIdempotencyKey` (already set at line 2909 to exactly `` `retry-${failure.retryId}` ``, reused here rather than re-deriving it) filters `attemptsForAgreement`; `expect(rowsWithRetryKey).toHaveLength(1); expect(rowsWithRetryKey[0]?.id).toBe(resultingPaymentAttemptId);` |
| Original attempt's pre-retry state is compared against its post-sequence state | `const originalAfterRecovery = attemptsForAgreement.find((row) => row.id === payment.id); expect(originalAfterRecovery).toEqual(payment);` — `payment` is the exact object captured at line 2902, before `coordinateFailure` or any `fireDueRetries` call ran. `attemptsForAgreement` rows come from `listPaymentAttemptsForAgreement`'s raw `db.select().from(paymentAttempt)`; `payment` is a `PaymentAttemptRecord` produced by `DrizzlePaymentAttemptRepository`'s `toRecord()` (`drizzlePaymentAttemptRepository.ts:11-39`), which is confirmed, by reading its full body, to be a direct, unrenamed field-for-field copy from the same underlying row shape — so this comparison is between two structurally identical representations of the same table row, not a type-shape mismatch waiting to produce a false failure |
| Fails if a third row is created, a second anchor exists, the original is replaced, or the retry points to the wrong anchor | A third row → `toHaveLength(2)` fails. A second anchor (two rows sharing the retry's idempotency key, or the anchor ID not matching) → the `rowsWithRetryKey` pair of assertions fails. The original replaced/removed → either it is absent from `attemptsForAgreement` (`originalAfterRecovery` is `undefined`, failing `toEqual(payment)`) or its `id` no longer appears in the ID-set assertion. The retry pointing to the wrong anchor → the ID-set assertion and the `rowsWithRetryKey[0]?.id` assertion both fail |

## D. What was explicitly NOT changed (ORDER 3)

- No change to `PaymentRetryService`, `FailedPaymentRetryCoordinator`, any provider implementation, repository, schema, or migration.
- No change to `createPerKeyProviderCallCounter` or its test-file usage — the three `callCounter.countFor(targetIdempotencyKey)` assertions (`toBe(2)`, `toBe(2)`, `toBe(3)`), the backoff-timestamp assertion, the no-premature-dispatch assertion, the execution-token-stability assertion, and the final `retryRow?.status === "fired"` assertion are all byte-for-byte unchanged.
- No change to R-B51 or any other test in this file — confirmed by the scoped diff in Section E below, whose only hunk is inside TEST 008-I.
- No fixture was deleted, no row was filtered out of an existing query, no shared database state was cleared, and no assertion was weakened — the correction adds identity/uniqueness assertions and widens the expected count from an incorrect 1 to the source-proven-correct 2; it does not relax what is being proven.
- No commit, push, merge, reset, stash, or deploy occurred. The pre-existing dirty worktree (every uncommitted change from every prior round of this engagement, none of which has ever been committed) is preserved exactly as it was, plus this one additional edit.

## E. Diff verification

`git diff --stat -- src/lib/payments/paymentWebhookRecovery.postgres.test.ts` (run from the verified authorized directory):
```
 .../paymentWebhookRecovery.postgres.test.ts        | 651 +++++++++++++++++++--
 1 file changed, 590 insertions(+), 61 deletions(-)
```

This large total is **not** produced by this round's edit — it is the cumulative, still-fully-uncommitted diff against HEAD `93bbbbf...` from every prior round of this engagement (the original 008-C test, then 008-F/008-F-BLOCKED/008-G/008-I's initial creation, the per-key-counter rewrite, the R-B51 rewrite, and now this correction), since no commit has ever been made on this branch during this engagement. Isolating this round's own hunk (by locating the new `STAGE 2 PHASE C 008-I ASSERTION CORRECTION` comment inside the saved diff) confirms it begins immediately after the pre-existing, unchanged `expect(retryRow?.status).toBe("fired");` line and ends immediately before the next, wholly untouched test (`R-B55`) — i.e., this round's actual edit is confined to the ~30-line block shown in Section B, and every line before it in the diff (including the rest of TEST 008-I's own body) is pre-existing, unmodified-this-round content that merely still shows as "added" relative to committed HEAD because it was never committed.

No file other than `paymentWebhookRecovery.postgres.test.ts` was touched by this round's edit (exactly one `Edit` tool call was made this round, targeting only this file).

## F. Offline verification results

| Command | Purpose | Result |
|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) | Full-repository static typecheck, including the corrected TEST 008-I | **0 errors, exit 0** |
| `npm run lint` (`eslint`) | Full-repository lint | **0 errors, exit 0**, 12 pre-existing warnings (identical set/locations to every prior round's own baseline — none in the lines this round touched; the two warnings inside this same file are at lines 4498/4548, both pre-existing `_omitted`-unused-variable warnings unrelated to TEST 008-I) |

Neither command connects to PostgreSQL, Docker, or any external provider — confirmed by their own definitions (`tsc --noEmit` performs no I/O beyond reading source files; `eslint` is a static analyzer) before running them.

`npm run test:postgres`, `--run-tests`, `docker version`/`docker info`, and any real database connection were **NOT EXECUTED** — not authorized under this order.

## G. Owner-provided evidence, not verified by this round

The order's own text states a previously observed PostgreSQL result of "280 passed and one failed." This is recorded here **exactly as owner-provided evidence**, not as a result this round produced or independently confirmed — consistent with the disclosed evidentiary gap in `STAGE_02_PHASE_C_008I_FINAL_FAILURE_DIAGNOSIS.md` Section A: no terminal log, exit code, or container-cleanup evidence for that specific run has been shown to this agent at any point, and this round performed no execution that could confirm or refute it. Whether the correction in Section B actually resolves that failure **remains unverified against real PostgreSQL** — this round is offline-only, per its own explicit authorization boundary.

## H. Remaining limitations, disclosed

1. The corrected assertions have never been executed against a real database. Their correctness rests on the source-level trace in `STAGE_02_PHASE_C_008I_FINAL_FAILURE_DIAGNOSIS.md` Section C-D (exhaustively following every `payment_attempt` insert/update call site reachable from this test's own code path) — a real run remains the only way to fully confirm it.
2. The `toEqual(payment)` comparison in Section C assumes `listPaymentAttemptsForAgreement`'s raw row shape and `DrizzlePaymentAttemptRepository`'s `toRecord()`-mapped shape are field-for-field identical for every column (verified by reading `toRecord`'s full body — a straight, unrenamed per-field copy) — if a database driver-level type quirk (e.g., a numeric column returned as a string in one path and a number in the other) exists that source reading alone cannot surface, this comparison could produce a false failure unrelated to the actual defect being tested; this is a theoretical residual risk disclosed here, not observed.
3. Per `STAGE_02_PHASE_C_008I_FINAL_FAILURE_DIAGNOSIS.md` Section E, whether the order's own "280/281, only 008-I" premise was accurate, and whether line 2946 specifically (as opposed to some other line) was the actual failing assertion in that unverified run, remains unconfirmed by this agent.

## I. Report verification

File: `docs/remediation/STAGE_02_008I_EXACT_ASSERTION_FIX.md`. Byte size and SHA-256 are recorded in the confirmation step immediately following this file's creation, using the same authorized-directory command structure as every other command this round.

*End of report.*
