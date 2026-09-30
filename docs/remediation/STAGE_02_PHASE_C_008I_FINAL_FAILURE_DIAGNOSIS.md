# Stage 2 — Phase C 008-I Final Failure Diagnosis

**PAID2YOU — STAGE 2 PHASE C FINAL FAILURE DIAGNOSIS**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: **read-only diagnosis only**. No database execution, no code modification, no test run, no Docker/PostgreSQL access, and no sibling-worktree access occurred in the course of this report. Generated: 2026-09-20.

**Repository identity, verified before any file access (via `git -C`, independent of shell cwd):** root `C:/Development/PAY2PAY-bank-v3`, branch `architecture/bank-managed-payments-v3`, HEAD `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` — all three match the required values. No file under `C:\development\pay2pay` was read, listed, or referenced.

---

## A. Evidentiary status of the claimed "280/281" run — stated up front

**This agent has not independently verified any execution producing "280 passing, 1 failing in TEST 008-I."** No terminal log, exit code, or container-cleanup evidence for such a run was provided in this order or found in any file under `docs/remediation/`. The only PostgreSQL executions of record in this engagement remain:

1. The original, authorized Phase C run (`STAGE_02_PHASE_C_REM008_POSTGRESQL_EXECUTION_REPORT.md`): **279/281 passed**, with TEST 008-I (provider-call-count assertion) and R-B51 (obsolete-architecture assertion) failing — both since remediated offline (per-key call counter; R-B51 rewritten for the current `payout.paid` no-op architecture), but **neither remediation has been re-run against real PostgreSQL since**, per this engagement's own unbroken record.
2. The Phase C diagnostic reproductions (`STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`): 3× real reruns, each showing the same `2 failed | 155 passed (157)` shape (narrowed single-file config), confirming 008-I and R-B51 as the two failures deterministically, before either fix existed.

No report of record, and no log shown to me in this or any prior order, documents a run where those two offline fixes were actually exercised against a real database. This diagnosis therefore proceeds **conditionally**: it takes the order's own stated premise — "one failed assertion in TEST 008-I" — as the question to investigate by source inspection, and reports what source code proves regardless of whether the specific "280/281" run actually occurred as described. Where the order's premise cannot be confirmed, that is stated as a limitation, not resolved by assumption.

**Exit code and container cleanup for the claimed run: UNVERIFIED.** No PowerShell output, `$LASTEXITCODE`, or `docker ps` result was supplied for it in this order, and this diagnostic authorization does not permit running anything to check.

---

## B. The exact assertion in question

`src/lib/payments/paymentWebhookRecovery.postgres.test.ts:2946`, inside `TEST 008-I` (starts at line 2819):

```ts
// No duplicate payment_attempt row was ever created for OUR agreement across the whole sequence
// (an unrelated retry belongs to a different agreement entirely, so this remains a precise check).
expect(await listPaymentAttemptsForAgreement(agreementId)).toHaveLength(1);
```

`listPaymentAttemptsForAgreement` (line 235):

```ts
/** REM-008: used to prove a blocked/repeated retry dispatch never creates a duplicate payment_attempt row for the same agreement. */
async function listPaymentAttemptsForAgreement(agreementId: string) {
  const db = getDb();
  return db.select().from(paymentAttempt).where(eq(paymentAttempt.agreementId, agreementId));
}
```

This is an **unfiltered** query: every `payment_attempt` row with this `agreementId`, regardless of status, is counted — there is no `WHERE status = ...` clause distinguishing "the original failed attempt" from "the retry's own new attempt."

## C. Full reconstruction of every payment_attempt row this test creates for its own `agreementId`

Traced end to end, by reading every write site that touches `payment_attempt` on this test's own code path — no database connection required, since every write is a literal `INSERT`/`UPDATE` statement in already-loaded source:

| Step (test line) | Call | `payment_attempt` effect | Row count for this `agreementId` after this step |
|---|---|---|---|
| 2902: `seedInstallmentPaymentWithMethod(agreementId, ...)` → `seedInstallmentPayment` (test file, lines 241-262) | `payments.insertPending({...agreementId...})` then `payments.updateStatus(inserted.id, "pending", {providerPaymentId})` | **INSERT** one row (id = `payment.id`), then an in-place UPDATE of the SAME row (status stays `"pending"`; only `providerPaymentId` set). No new row. | **1** |
| 2903: `coordinator.coordinateFailure({ installmentScheduleItemId, payment })` | `failedPaymentRetryCoordinator.ts:1105-1233` | Reads `payment.agreementId`/`payment.id` only to lock the agreement and insert a **`payment_retry`** row (`originalPaymentAttemptId: input.payment.id`). **This method never inserts, updates, or otherwise touches the `payment_attempt` table anywhere in its body** (confirmed by reading its full transaction, lines 1106-1209: the only writes are to `installmentScheduleItem.status` and `paymentRetry`). | **1** (unchanged) |
| 2913: `retryService.fireDueRetries(t0)`, first pass over `findDueForFiring` → `coordinator.claimAndExecuteRetry(...)` (`paymentRetryService.ts:439`) → `establishDurableDispatchIntent` (`failedPaymentRetryCoordinator.ts:1598-1726`) | Line 1651: looks up `payment_attempt` by `idempotencyKey = "retry-<retryId>"` first; none exists yet, so line 1689 **INSERTs a NEW row** — the "anchor" — with this SAME `agreementId` (`input.agreementId`, line 1699), `status: "submitted"`. | **2** |
| Same `fireDueRetries` call, immediately after, `dispatchProviderCallForAnchor` (`:1742`) | Re-reads the anchor by `paymentAttemptId` (line 1784) and, on an `AmbiguousProviderResponseError`, sets its status to `"submitted"`-family ambiguous state — an **UPDATE of the same anchor row**, not an insert (confirmed: no `tx.insert(paymentAttempt)` call appears anywhere in `dispatchProviderCallForAnchor`'s body). | **2** (unchanged) |
| 2929: second `fireDueRetries(beforeEligible)` call — retry is `"claimed"`, so this goes through `findClaimedForResumption` → `resolveAmbiguousRetry` (`:2059`) | Line 2076: looks up the SAME anchor by the SAME `idempotencyKey`; line 2080 branch (`existing.status !== "submitted"`) or the `validateAndAdoptLegacyReplacement`/`resolveNotFoundOutcome` branch — every path re-reads/updates `existing.id`. **No `tx.insert(paymentAttempt)` call exists anywhere in `resolveAmbiguousRetry` or `resolveNotFoundOutcome`** (confirmed by reading both methods, lines 2059-2141 and 2158 onward). | **2** (unchanged) |
| 2939: third `fireDueRetries(afterEligible)` call — same resumption path, provider now accepts | Same anchor row, updated to a terminal success state via `applyFoundOutcome`/`resolveNotFoundOutcome`'s dispatch branch. Still the same physical row. | **2** (unchanged, terminal) |

**Conclusion, established entirely from source, with no database row inspection required:** under the current, unmodified production code, this exact test body deterministically produces **exactly 2** `payment_attempt` rows for its own `agreementId` — the original seeded (failed) attempt, and the one retry-dispatch anchor — every single time it runs to completion, regardless of shared-database contamination, run order, or any other test's activity. `establishDurableDispatchIntent`'s own idempotency-key existence check (line 1651-1653) is precisely what guarantees the anchor itself is never duplicated across the three `fireDueRetries` calls; nothing in the traced call graph can produce a THIRD row for this `agreementId`, and nothing can reduce the count below 2 (the original row is never deleted or reassigned to a different agreement anywhere in this file).

## D. Why this is not a test-isolation defect and not a production duplicate-dispatch defect

The order asks specifically to rule these two categories in or out before proposing anything:

- **Cross-test / shared-database contamination:** Ruled out by source. `agreementId` is a fresh UUID generated per test via `seedAgreementWithInstallment` (called once, per-test, at line 2900) — no other test in this 150+-test file can ever produce a row carrying THIS test's own `agreementId`, because every write site in Section C above sources `agreementId` from either this test's own local variable or from `retry.agreementId`/`input.agreementId` threaded from the SAME retry this test alone created. This is structurally different from the earlier, already-fixed 008-I defect (the provider-call counter), where the shared `fireDueRetries` **table-wide sweep** could process a genuinely unrelated row — that sweep-based contamination is real for the provider-call counter (fixed by `createPerKeyProviderCallCounter`) but is **not applicable** to `listPaymentAttemptsForAgreement`, which is scoped by `agreementId`, not by a global counter. The order's own suggestion to check whether the new per-key counter "could allow an unrelated scheduler operation to... create another local payment-attempt record" was checked directly (Section C, `fireDueRetries` and `establishDurableDispatchIntent`): an unrelated retry swept up in the same batch call always carries **its own** `agreementId` (line 443: `agreementId: retry.agreementId`), never this test's — so no unrelated scheduler operation can insert a row against this test's `agreementId`.
- **Duplicate durable payment-attempt creation (a production defect):** Ruled out by source. The SECOND row is not an accidental duplicate of the retry's own dispatch — it is created exactly once, by exactly one call site (`establishDurableDispatchIntent`, line 1689), guarded by an idempotency-key existence check inside the same lock/transaction that performs the insert. Every subsequent touch (ambiguous resumption ×2, final success) updates that same row. There is no evidence anywhere in the traced call graph of a second, distinct anchor row ever being created for the same retry. This is the intended two-record model this codebase already documents elsewhere in this exact file (`coordinateFailure`'s own doc comment, line 1107-1108: "this method is the ONLY one... that INSERTs a NEW `payment_retry` row" — implicitly, and `establishDurableDispatchIntent`'s own doc comment, lines 1582-1596, explicitly describing the anchor as a **new**, idempotent-re-entry-protected row, distinct from whatever payment originally failed).

**What this actually is:** the test's own assertion encodes an incorrect expected value. Its own comment ("No duplicate payment_attempt row was ever created... across the whole sequence") correctly describes the invariant the test author intended to prove — that the retry's OWN dispatch sequence (claim, ambiguous ×2, resolve) never creates more than one anchor row — but the literal assertion (`toHaveLength(1)` against the **agreement-wide, unfiltered** row count) also inadvertently counts the pre-existing original failed attempt that was seeded before the retry ever began. The intended invariant is real and, per Section C, is already true; the assertion chosen to express it is not the right measurement.

## E. What remains genuinely unverifiable without real database-row evidence

To be explicit about the boundary between source-proven fact and what only an actual run could add:

- **The exact numeric value PostgreSQL would return** for `listPaymentAttemptsForAgreement(agreementId)` in a live run is a prediction (2) derived from exhaustive source tracing, not an observed value — no query was executed. If it differed from 2 in an actual run, that would itself be new evidence of a control-flow path not accounted for above (e.g., an error branch this analysis did not anticipate), and would need to be investigated against real rows, not reasoned about further from source alone.
- **Whether the claimed "280/281, only 008-I failing" run actually took place**, and whether line 2946 specifically is what failed in it (as opposed to one of this same test's OTHER assertions, e.g., lines 2914/2930/2940), is **not verifiable from anything available to this agent**. The order's own framing (directing inspection specifically to `listPaymentAttemptsForAgreement` at line 2946) is treated here as the working hypothesis, consistent with and fully explained by Section C-D's source analysis — but it is a hypothesis adopted because it fits the evidence perfectly, not a confirmed fact.
- **Whether R-B51's rewritten assertions (from the prior remediation round) pass against real PostgreSQL** remains completely unverified — no execution of that test has occurred since it was rewritten offline.

## F. Minimal correction proposal (NOT implemented this round)

**Exact file scope:** `src/lib/payments/paymentWebhookRecovery.postgres.test.ts`, TEST 008-I only (lines 2819-2947). No production file. No other test.

**Proposed change:** replace the single unscoped-count assertion at line 2946 with assertions that verify the actually-intended invariants precisely, using identity rather than a bare count of an unfiltered, multi-purpose table:

1. Capture the original attempt's id before the retry sequence begins (already available: `payment.id`, from line 2902's own return value).
2. After the sequence completes, assert `listPaymentAttemptsForAgreement(agreementId)` has length **2** (replacing the incorrect `1`) — proving no unrelated third row appeared.
3. Assert the two rows' ids are exactly `{ payment.id, resultingAnchorId }`, where `resultingAnchorId` is read from the retry's own `payment_retry.resultingPaymentAttemptId` column (already written by `establishDurableDispatchIntent`, line 1722) — proving the second row is genuinely THIS retry's own anchor, not merely "some other row that happens to make the count 2."
4. Assert `payment.id`'s own row is unchanged from its pre-retry state (`status` still `"pending"`, no `providerPaymentId` overwrite) — proving `coordinateFailure`/the retry machinery never mutates the original attempt, only ever creates and resolves its own separate anchor.
5. Keep the existing `providerPaymentId`-non-null / `status === "fired"`-on-the-retry-row assertions (lines 2941-2942) unchanged — this proposal touches only the payment-attempt-count assertion and its immediate replacement, not the retry-row or callCounter assertions, all of which already correctly test what they claim.

**Required positive test:** the corrected assertion set above, exercised through this test's own existing ambiguous-then-succeed sequence (no new fixture needed).

**Required negative test (new, offline, dependency-injected — not this file):** a unit-level test proving `establishDurableDispatchIntent`'s idempotency-key lookup (line 1651) actually prevents a second insert when called twice with the same `idempotencyKey` — this exists implicitly across the three real `fireDueRetries` calls in TEST 008-I itself, but an isolated, fast, offline test of `establishDurableDispatchIntent` alone (fake `tx`, asserting the second call short-circuits to `"already_dispatched"` without a second `insert` call) would pin this guarantee independently of the shared-database integration test, consistent with this engagement's existing pattern of pairing an integration assertion with a fast offline regression pin (e.g., `createPerKeyProviderCallCounter.test.ts`).

**This proposal is not implemented.** No file was modified in the course of producing this report.

## G. Everything preserved unchanged

`docs/remediation/STAGE_02_PHASE_B_ISOLATION_AND_HARNESS_EVIDENCE.md`, `STAGE_02_PHASE_C_REM008_POSTGRESQL_EXECUTION_REPORT.md`, `STAGE_02_ROLE_OWNERSHIP_FINAL_CORRECTION_AND_PHASE_B_APPROVAL.md`, `STAGE_02_PHASE_B_SUPPLEMENTAL_EVIDENCE_AND_AUTHORIZATION.md`, `STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md`, `STAGE_02_FINAL_PREAUTHORIZATION_CLARIFICATION.md`, `STAGE_02_PHASE_C_TWO_FAILURES_REMEDIATION_AND_EXECUTION_READINESS.md`, `STAGE_02_FOUR_FINDINGS_REMEDIATION_AND_GATE_B_READINESS.md`, and `STAGE_02_PHASE_B_SUPPLEMENTAL_EXECUTION_REPORT.md` were read where relevant but not modified. No production source file, migration, or test file was modified. No commit, push, merge, deploy, Docker command, PostgreSQL connection, or test run occurred.

## H. Report verification

File: `docs/remediation/STAGE_02_PHASE_C_008I_FINAL_FAILURE_DIAGNOSIS.md`. Byte size and SHA-256 are recorded in the confirmation step immediately following this file's creation.

*End of report.*
