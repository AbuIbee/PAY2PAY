# Stage 3 — G01–G12 Execution and Acceptance Report

**PAID2YOU — STAGE 3 EXACT IMPLEMENTATION CONTRACT**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Executed under the Project Owner's explicit "APPROVED FOR EXECUTION" authorization. No Docker, no PostgreSQL connection, no commit/push/merge/deploy, no real financial provider contact. Generated: 2026-09-21.

**Outcome: OUTCOME 3 — BLOCKED.** The two authorized factory corrections are implemented, correct, and confirmed not to regress anything. Full G01–G09 completion is blocked by one newly-discovered, pre-existing eager-provider dependency in a **third** production file (`src/lib/payments/getPaymentService.ts`), reached transitively through `getPaymentRetryService()`'s own `initiators` construction — outside the two-file allowlist this order authorizes. This report requests the exact additional authorization needed, per Order 10.

---

## A. Repository identity and preserved baseline

Every shell invocation began with `Set-Location -LiteralPath "C:\Development\PAY2PAY-bank-v3"` plus a hard mismatch guard. Verified fresh at the start of this order: working directory `C:\Development\PAY2PAY-bank-v3`, repository root `C:/Development/PAY2PAY-bank-v3`, branch `architecture/bank-managed-payments-v3`, HEAD `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` — unchanged from the previously verified value; not reset. `AGENTS.md`/`CLAUDE.md` (both read in an earlier round this session) impose no conflicting restriction. `C:\development\pay2pay` was not accessed beyond the shell tool's own ambient cwd-reset notices between invocations.

**Baseline dirty-worktree inventory:** `git status --porcelain` showed **108 entries** immediately before this order's first edit — identical to the count recorded at the start of the prior investigation turn, confirming nothing changed in the interim. The pre-existing dirty tree spans dozens of files across payments/ach/debitCard/ledger/notify/providers/etc. (full listing captured in this order's own working `git status` output) — none of it was created by this order; all of it is preserved untouched except the four files listed in Section B.

## B. Files modified by this assignment

| File | Type | Change |
|---|---|---|
| `src/lib/payments/getPaymentWebhookService.ts` | Production (authorized) | `provider: getPaymentProvider(),` → `get provider() { return getPaymentProvider(); },` (+14/-2, per `git diff --stat`) |
| `src/lib/failedPayments/getPaymentRetryService.ts` | Production (authorized) | Same transformation (+16/-2) |
| `src/lib/payments/getPaymentWebhookService.test.ts` | New test (allowlisted category) | G01/G05 factory-construction and invocation-boundary tests |
| `src/lib/failedPayments/getPaymentRetryService.test.ts` | New test (allowlisted category) | G02/G06 factory-construction and invocation-boundary tests |

**No other file was modified by this assignment.** `src/lib/payments/paymentWebhookService.ts` was read (to confirm the constructor does not eagerly access `deps.provider`) but not edited, per Order 03. No file from the pre-existing 108-entry dirty tree was touched.

## C. The exact original defect and before/after

**Before:** both factories evaluated `provider: getPaymentProvider()` as an object-literal property during `new PaymentWebhookService({...})`/`new PaymentRetryService({...})` construction — i.e. eagerly, synchronously, before the constructed object even exists. Since `PROVIDER_CAPABILITY_REGISTRY` is intentionally empty (no live V3 provider approved yet), `getPaymentProvider()` unconditionally throws `ProviderNotAvailableError` today, so both entire services failed to construct, blocking every capability they expose — including ones (`recoverBatch`, `receiveInternalEvent`, `findForOriginalPayment`) that never touch the provider at all.

**After:** both factories supply `provider` as a getter:
```ts
get provider() {
  return getPaymentProvider();
},
```
`getPaymentProvider()` is now invoked only when something actually reads `.provider` — i.e. inside `PaymentWebhookService.receiveWebhook` (the sole method that touches `this.deps.provider`, confirmed by an exhaustive full-file search for `deps.provider`/`this.provider`/`PaymentProvider` in `paymentWebhookService.ts`) and inside `PaymentRetryService.fireDueRetries`'s own pre-existing `if (!this.deps.provider) throw ...` guard (confirmed the only two `deps.provider` occurrences in `paymentRetryService.ts`). Both constructors were confirmed, by reading their full bodies, to be plain `private readonly deps: {...}` parameter properties with no spreading, destructuring, or enumeration of `deps` — so the getter is never evaluated during construction.

## D. The newly-discovered blocker

Running the new G01/G02 tests (provider mocked to **throw**, not the existing recursion suite's inert-success double) surfaced a real, pre-existing, previously-masked chain:

```
getPaymentRetryService()                              [authorized file — now lazy, no longer throws here]
  → initiators.ach: getAchPaymentService()             [src/lib/ach/getAchPaymentService.ts:14 — eager]
    → payments: getPaymentService()                    [src/lib/payments/getPaymentService.ts:14]
      → provider: getPaymentProvider()                 [src/lib/payments/getPaymentService.ts:57 — EAGER, throws]
```
and identically for `getPaymentWebhookService()` via `getFailedPaymentWorkflowService() → getPaymentRetryService() → getAchPaymentService() → getPaymentService()`.

**This defect already existed before this order.** It was invisible until now only because `getPaymentWebhookService.ts`'s/`getPaymentRetryService.ts`'s own eager `provider: getPaymentProvider()` call (now fixed) always threw *first*, in the same object literal, before JavaScript's left-to-right property evaluation ever reached the `initiators`/dependency-graph properties that lead to `getPaymentService.ts`. Fixing the two authorized files did not introduce this problem — it removed the earlier failure that was masking it.

`getPaymentService.ts:57` (`provider: getPaymentProvider(),`) is the actual root: `PaymentService.deps.provider` is **required** (non-optional, unlike `PaymentRetryService`'s already-optional `provider?`), and is read in `createPayment`/`cancelPayment`/`refundPayment` (confirmed by a full-file search of `deps.provider`/`this.provider` in `paymentService.ts`) — a broader surface than `PaymentWebhookService`'s single `receiveWebhook` usage. `PaymentService`'s own constructor is, like the other two, a plain parameter property with no eager access — so the identical lazy-getter mechanism would mechanically work here too, but applying it requires editing `getPaymentService.ts` (and possibly widening `PaymentService.deps.provider` to optional with an explicit guard at each of its three use sites, mirroring `PaymentRetryService`'s existing pattern) — **a file entirely outside this order's two-file allowlist.**

Per Order 10: **the exact remaining eager access is `getPaymentService.ts:57`, reached via `getAchPaymentService.ts:14` and `getDebitCardPaymentService.ts:15` (both would reach it identically — `debit_card`'s path was not independently triggered in this run only because `ach` is evaluated first in the same `initiators` object literal), which is outside the authorized allowlist. This report STOPS here and requests additional file authorization for `src/lib/payments/getPaymentService.ts` (and, if the owner wants the identical guard-at-use-site treatment `PaymentRetryService` already has, `src/lib/payments/paymentService.ts`'s three `deps.provider` read sites) rather than silently expanding scope.**

## E. G01–G11 acceptance matrix

| Gate | Requirement | Evidence | Disposition |
|---|---|---|---|
| **G01** | Webhook factory: cold construction succeeds, zero provider calls during construction, exposes `recoverBatch` | `src/lib/payments/getPaymentWebhookService.test.ts`, `npx vitest run` — **FAILS**: `ProviderNotAvailableError` thrown via the Section D chain before the assertion is ever reached | **BLOCKED** — root cause is `getPaymentService.ts:57`, outside the allowlist; not a defect in either authorized file |
| **G02** | Retry factory: cold construction succeeds, zero provider calls, exposes `findForOriginalPayment` | Same test file/run, retry-service test — **FAILS**, identical root cause | **BLOCKED** — same as G01 |
| **G03** | Historical recovery availability (`recoverBatch`) | Construction itself is blocked (G01); the provider-independence of `recoverBatch`'s own body (never touches `this.deps.provider`, confirmed by source search) is not in question, but no assertion could be executed against the real factory-constructed instance | **BLOCKED** — depends on G01; additionally, the "exact expected recovery result" portion would require a real, disposable PostgreSQL instance (not authorized this round) once construction is unblocked |
| **G04** | Retry-status lookup (`findForOriginalPayment`) | Construction blocked (G02); `findForOriginalPayment`'s own body never touches `this.deps.provider` (confirmed by source search), but no assertion could be executed | **BLOCKED** — depends on G02; the fixture-match portion would additionally require real PostgreSQL once unblocked (no in-memory fixture path exists for this repository-backed method without one) |
| **G05** | Unauthenticated inbound webhook rejects cleanly | Test written and would prove this precisely (provider genuinely resolved at invocation time, not zero) — but construction itself fails first (G01) | **BLOCKED** — same root cause; the test is ready to pass once G01 is unblocked |
| **G06** | Provider-dependent retry protection (`fireDueRetries`) | Test written and would prove the existing guard remains effective — but construction fails first (G02) | **BLOCKED** — same root cause; test is ready to pass once G02 is unblocked |
| **G07** | Initiation authorization unaffected | `npx vitest run src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts` — **27/27 pass**, exit 0, file unmodified; `paymentWebhookService.test.ts`'s existing REM-009 describe block (historical processing preserved when initiation disabled) — included in the 18/18 pass below | **VERIFIED** — this gate does not depend on the two factories under repair and shows zero change |
| **G08** | Cold construction, recursion, caching | `npx vitest run src/lib/failedPayments/productionFactoryRecursion.test.ts` — **5/5 pass**, exit 0, file unmodified. This proves no recursion regression **when the provider resolves successfully** (its own `mockProviderBoundary()` returns a non-throwing double, unlike G01/G02's throwing mock) | **PARTIALLY VERIFIED** — recursion/caching confirmed unaffected for the "provider available" case; the "provider unavailable" cold-construction case is BLOCKED, identically to G01/G02 |
| **G09** | Financial invariant preservation | Diff inspection (Section B): only the two authorized factories + two new test files changed — zero payment-submission, event-application, ledger, settlement, payout, schema, or migration files touched. Focused tests: `paymentWebhookService.test.ts` 18/18, `paymentRetryService.test.ts` 23/23, `failedPaymentRetryCoordinatorActivationGate.test.ts` 27/27 — all pass unmodified (68/68 total). No new `createPayment` call site introduced (the change is a property-access mechanism only). No webhook-authentication bypass (`receiveWebhook`'s signature check is untouched, still the method's first statement). No duplicate-financial-effect path introduced (no processing logic changed). Direct-transfer/historical-payout boundary unchanged (no payout/ledger file touched) | **VERIFIED**, by executed-test evidence (68/68 unit tests) plus source-diff inspection (no financial-processing file changed) — this report does not claim payout/ledger certification, only that this factory-scoped change introduces none of the listed risks |
| **G10** | Test-execution policy | Focused tests: 68/68 pass (Section G09) + 5/5 recursion pass. `npm run typecheck`: **0 errors, exit 0**. `npm run lint`: **0 errors, exit 0**, 12 pre-existing warnings (identical set/locations to every prior round). Full non-PostgreSQL regression, run once: **2,244 passed / 4 failed, 2,248 total, 258 files passed / 2 failed, 260 total**, exit 1 — the 4 failures are exactly G01/G02/G05/G06 in the two new test files, all attributable to the single Section D root cause; zero other regression anywhere in the remaining 2,244 tests | **BLOCKED** — every required check ran and produced complete, honest evidence; the gate cannot be called VERIFIED while 4 tests fail against an unresolved, disclosed blocker (not an owner-accepted limitation yet) |
| **G11** | Database-execution decision | No database access was needed to find or would be needed to fix the Section D blocker itself. However, Stage 3 is not complete: G03/G04's persisted-evidence portions (and re-verification of G01/G02/G05/G06 once unblocked) will require the disposable-PostgreSQL harness once the blocker is resolved | **NOT YET DETERMINABLE AS BLOCKED-OR-CLEAR** — premature to classify against an incomplete diff; recorded here as a known future requirement, not decided now. **No Docker or PostgreSQL execution occurred or is requested by this report.** |

## F. Full regression detail

Command: `npx vitest run` (from the verified authorized directory). Exit code: `1`. Result: `Test Files 258 passed | 2 failed (260)`, `Tests 2244 passed | 4 failed (2248)`. The 4 failures, verbatim identity:

- `getPaymentWebhookService.test.ts` → `G01 — a cold construction succeeds with the provider unavailable...`
- `getPaymentWebhookService.test.ts` → `G05 — receiveWebhook on the real factory-constructed service rejects...`
- `getPaymentRetryService.test.ts` → `G02 — a cold construction succeeds with the provider unavailable...`
- `getPaymentRetryService.test.ts` → `G06 — fireDueRetries on the real factory-constructed service still fails closed...`

Every one fails with the identical stack trace terminating at `getPaymentService.ts:57` via the Section D chain — a single root cause, not four independent defects. No other test file shows any failure, warning-count change, or timing anomaly versus the prior accepted baseline (257 files / 2,237 tests recorded in `CONTROL_ORDER_004-B_SV-007_FACTORY_TEST_CORRECTION.md`; the file/test-count increase to 260/2,248 reflects the two new Stage 3 test files this order added, not scope creep elsewhere).

## G. Authentication, authorization, and idempotency boundaries — unaffected

`receiveWebhook`'s HMAC signature verification remains the unconditional first statement of that method (unchanged line, now reached via a getter instead of a pre-resolved value — no semantic change to *when* it runs relative to any other step). `fireDueRetries`'s existing `if (!this.deps.provider) throw ...`/eligibility/effectApplier guards are unchanged in source; only how `provider` itself is supplied changed. No idempotency key, execution token, retry identity, or claim-ownership logic was touched in either service. No `createPayment` call site was added, removed, or relocated.

## H. Remaining limitations, disclosed

1. **The Section D blocker is the sole reason G01/G02/G05/G06/G08(partial)/G10 are not VERIFIED.** It requires explicit additional authorization to touch `src/lib/payments/getPaymentService.ts` (root cause) and, for full symmetry with `PaymentRetryService`'s existing pattern, potentially `src/lib/payments/paymentService.ts` (widen `deps.provider` to optional + guard at its three use sites) — this report does not implement either without that authorization.
2. G03/G04's fixture-backed, persisted-result assertions will additionally require a real disposable-PostgreSQL run once G01/G02 are unblocked — not requested or executed here.
3. `getDebitCardPaymentService.ts`'s identical path through `getPaymentService.ts` was not independently exercised in this run (JavaScript property-evaluation order meant `ach` failed first in the shared `initiators` object literal) but is structurally certain to hit the same root cause, based on identical source (`getDebitCardPaymentService.ts:15` → `getPaymentService.ts:57`).

## I. Owner decision requested

**Minimum requested authorization to resolve OUTCOME 3 and complete G01–G11:**

Add `src/lib/payments/getPaymentService.ts` to the production-file allowlist, with the same prescribed mechanism: replace its eager `provider: getPaymentProvider(),` (line 57) with the identical `get provider() { return getPaymentProvider(); },` getter. Separately confirm whether `src/lib/payments/paymentService.ts`'s `deps.provider` (currently required, read at 3 sites: `createPayment`/`cancelPayment`/`refundPayment`) should also become optional with an explicit guard mirroring `PaymentRetryService`'s existing `if (!this.deps.provider) throw ...` pattern, or whether the getter alone (still required-typed) is judged sufficient since `PaymentService`'s constructor itself does not eagerly touch it either.

No other production file, test file, schema, or migration is implicated by this blocker.

## J. G12

```
G12 — AWAITING INDEPENDENT CODEX REVIEW
```

Handoff for Codex: this report, the exact two-file production diff (Section B/C), the two new test files (currently containing 4 correctly-failing tests that document the blocker rather than a defect in the authorized files), the full-regression output (Section F), and this Section I decision request. G11 remains undecided pending resolution of Section D. No Stage 4 activity, provider selection, real financial operation, or deployment occurred or is proposed.

## K. Report verification (original round)

File: `docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md`. Byte size and SHA-256 recorded in the confirmation step immediately following this file's creation (superseded by the final values in Section T, which reflect this file after the continuation addendum below).

**Everything above this line is the original, unmodified Section A–K record from the first Stage 3 round (OUTCOME 3 — BLOCKED). It is preserved exactly as originally written, including the 2,244-passed/4-failed/exit-1 regression result, which was real and accurate at that time.**

---

# CONTINUATION ADDENDUM — Owner's manual third-factory correction and final acceptance

**PAID2YOU — STAGE 3 EXACT EXECUTION CONTINUATION AND G01–G12 ACCEPTANCE ORDER.** Agent: Claude Code. Mode: verification of the Project Owner's manually applied correction, completion of the previously blocked acceptance gates, and one final validation campaign. No production-code implementation was performed by this addendum — `getPaymentService.ts` was edited by the Project Owner, not by this agent. Generated: 2026-09-21 (continuation of the same date as the original round).

## L. Repository re-verification

Fresh checks at the start of this continuation, and again after the owner's second correction attempt: working directory `C:\Development\PAY2PAY-bank-v3`, root `C:/Development/PAY2PAY-bank-v3`, branch `architecture/bank-managed-payments-v3`, HEAD `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` — unchanged throughout, matching every prior round. `git status --porcelain` line count: **111** (up from the original round's 108-entry baseline by exactly the 3 new untracked files that round added: the two new test files and the original report — consistent, no unexplained drift). `AGENTS.md`/`CLAUDE.md` re-confirmed non-conflicting (unchanged since the prior round's reading).

## M. The owner's manual correction — three attempts, verified from disk each time

This agent read the actual saved file from disk before every disposition below — never a screenshot or editor buffer, per Order 02.

**Attempt 1 (rejected):** `src/lib/payments/getPaymentService.ts` lines 56–59 read:
```ts
    cached = new PaymentService({
      get provider() {
  return getPaymentProvider();
      // Payment activation gate (SC-10): see PaymentService.createPayment's own doc comment for
```
The getter's closing `}` was missing entirely — every subsequent property (`newPaymentInitiationVerified` through `installmentHook`) was left nested inside the unclosed getter body. `npm run typecheck` confirmed this: exit code 2, **17 errors** in this file (`TS1005`/`TS1109`/`TS1128`, lines 63–79). This agent did not modify the file and reported the exact lines and diagnostics, then stopped, per Order 02's explicit instruction not to substitute its own implementation.

**Attempt 2 (rejected):** lines 57–59 read:
```ts
      get provider() {
  return getPaymentProvider()};
      // Payment activation gate (SC-10): see PaymentService.createPayment's own doc comment for
```
The getter's closing `}` was now present, but it was followed by a semicolon (`;`) where a comma (`,`) is required to separate it from the next object-literal property. `npm run typecheck` confirmed: exit code 2, exactly **1 error** — `getPaymentService.ts(58,31): error TS1005: ',' expected.` This agent again reported the exact line and diagnostic without modifying anything, and stopped.

**Attempt 3 (accepted):** lines 56–59 now read:
```ts
    cached = new PaymentService({
      get provider() {
  return getPaymentProvider()},
      // Payment activation gate (SC-10): see PaymentService.createPayment's own doc comment for
```
`npm run typecheck` — **0 errors, exit 0**, across the entire repository. `git diff -- src/lib/payments/getPaymentService.ts` confirms the only `provider`-related change is `-      provider: getPaymentProvider(),` replaced by `+      get provider() {` / `+  return getPaymentProvider()},` — no duplicate `provider` property, no second callback, no malformed argument. Every other constructor property (`newPaymentInitiationVerified`, `verification`, `profileOwners`, `payments`, `audit`, `agreements`, `balances`, `ledger`, `completion`, `atomicManualPayments`, `installmentReserver`, `scheduleReader`, `settlementContext`, `notifications`, `installmentHook`) is byte-for-byte unchanged from before this correction, confirmed by a full re-read of the file. `installmentHook.handlePaymentSucceeded` remains the pre-existing deferred lazy thunk (`(payment) => getFailedPaymentWorkflowService().handlePaymentSucceeded(payment)`), invoked only when `handlePaymentSucceeded` is actually called, not during construction — unchanged from the original design documented in this same file's own doc comment.

**Attribution:** the `getPaymentWebhookService.ts` and `getPaymentRetryService.ts` corrections (Section B/C, original round) were made by this agent. The `getPaymentService.ts` correction (all three attempts) was made entirely by the Project Owner, manually, outside this agent's tool calls — this agent's role in this addendum was exclusively verification (read the file, run the compiler, report or proceed), never authorship.

## N. Three-factory joint verification (Order 03)

All three factories confirmed, by direct re-read this round, to supply `provider` via the identical `get provider() { return getPaymentProvider(); }` mechanism. `PROVIDER_CAPABILITY_REGISTRY` re-confirmed unchanged (`providerCapabilities.ts:71`, still `{}`) — no fallback provider, no new registry, no global placeholder, no suppressed exception anywhere. `getPaymentWebhookService.ts`/`getPaymentRetryService.ts` are unmodified since the original round (only `getPaymentService.ts` changed this round). No constructor spreads, destructures, or otherwise eagerly enumerates `deps`, confirmed in the original round and unchanged.

## O. The four previously failing tests — now passing

Command: `npx vitest run src/lib/payments/getPaymentWebhookService.test.ts src/lib/failedPayments/getPaymentRetryService.test.ts`. Result: **4/4 pass**, exit 0.
- `G01 — a cold construction succeeds with the provider unavailable...` — **PASS**
- `G05 — receiveWebhook on the real factory-constructed service rejects...` — **PASS**
- `G02 — a cold construction succeeds with the provider unavailable...` — **PASS**
- `G06 — fireDueRetries on the real factory-constructed service still fails closed...` — **PASS**

Each test's own assertions (zero provider calls during construction; nonzero, boundary-only invocation at actual use; rejection under the existing provider-unavailable contract) executed and passed — not merely "construction did not throw."

## P. Remaining focused tests (Order 05)

Command: `npx vitest run src/lib/payments/paymentWebhookService.test.ts src/lib/failedPayments/paymentRetryService.test.ts src/lib/failedPayments/productionFactoryRecursion.test.ts src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts src/lib/payments/getPaymentWebhookService.test.ts src/lib/failedPayments/getPaymentRetryService.test.ts`. Result: **6 files passed, 77/77 tests passed, exit 0.** No test file was modified to obtain this result.

**G08 — ACH and debit-card paths independently confirmed, not inferred by analogy:** `getPaymentRetryService()`'s own object literal (`getPaymentRetryService.ts:70-85`) constructs `initiators: { ach: getAchPaymentService(), debit_card: getDebitCardPaymentService(), manual_off_platform: {...} }` — both `ach` and `debit_card` properties are evaluated unconditionally, as sibling properties of the same object literal, during every cold construction. The G02 test's successful pass therefore proves both `getAchPaymentService()`'s and `getDebitCardPaymentService()`'s own factory bodies executed successfully in the same run (each internally calling `getPaymentService()` — the second call returns the already-cached singleton, but `DebitCardPaymentService`'s and `AchPaymentService`'s own constructor bodies still ran to completion). This was verified by source inspection of the exact object-literal structure, not merely assumed from the ACH result alone.

**G07 (initiation authorization):** `failedPaymentRetryCoordinatorActivationGate.test.ts` — 27/27 pass, unmodified. `paymentWebhookService.test.ts`'s own REM-009 describe block ("historical event processing is preserved when new payment initiation is disabled") — included in the 18/18 pass, unmodified.

## Q. Security and financial boundaries (Order 06) — reconfirmed

`receiveWebhook`'s signature verification remains its unconditional first statement (`paymentWebhookService.ts:554`, file untouched this round). `receiveInternalEvent` remains reachable only from `FailedPaymentRetryCoordinator.resolveAmbiguousRetry` — no new HTTP route was added or changed. `fireDueRetries`'s existing `if (!this.deps.provider) throw ...`/eligibility/effectApplier guards are unchanged in source. No new `createPayment` call site exists anywhere in the diff (confirmed: only `getPaymentService.ts`'s `provider` property changed in the third file; `paymentService.ts` itself, where `createPayment`/`cancelPayment`/`refundPayment` live, was not touched). The direct-transfer/historical-payout boundary is untouched (no payout/ledger file in the diff). No material authentication or financial-integrity defect was found.

## R. Final validation campaign (Order 07)

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **0 errors, exit 0** |
| `npm run lint` (`eslint`) | **0 errors, exit 0**, 12 pre-existing warnings, identical set/locations to every prior round — none in any file this round touched |
| `npx vitest run` (full non-PostgreSQL suite, run exactly once) | **260 files passed (260), 2,248 tests passed (2,248), exit 0** |

This supersedes the original round's regression result (`2,244 passed / 4 failed / 2,248 total, exit 1`) — that original result is preserved above (Section F) as accurate historical evidence of the then-existing blocker, not deleted or overwritten. The test collection total (2,248) is identical between the two runs — the original round's 4 failures are now 4 passes; no test was added, removed, or skipped to change the count.

## S. G11 — database-evidence decision (Order 08)

`G03` (historical recovery via `recoverBatch`) and `G04` (retry-status lookup via `findForOriginalPayment`) are now **VERIFIED for construction/exposure and zero-unnecessary-provider-dependency** (G01/G02 above establish this for the same underlying factories). Their remaining, more specific requirement — "any executable authorized local fixture produces its exact expected result" against real persisted rows — is **not establishable from any existing authorized test**: no existing `.postgres.test.ts` file constructs `PaymentWebhookService`/`PaymentRetryService` via the real production factories (`getPaymentWebhookService()`/`getPaymentRetryService()`); every existing PostgreSQL test (including the whole `paymentWebhookRecovery.postgres.test.ts` suite) constructs these services directly with manually-supplied real repositories, bypassing the factories entirely. This is a genuine, currently-unfilled evidence gap, not inferable from the passing suites above.

**Exact minimum new evidence, if separately authorized:** one new test (in a new or existing `.postgres.test.ts` file) that (1) imports `getPaymentWebhookService()`/`getPaymentRetryService()` directly — the real factories, not manual construction, (2) seeds one durably-persisted recoverable webhook event row (for G03) and one durably-persisted retry row belonging to a known original payment attempt (for G04) using this suite's own existing seed helpers, (3) invokes `recoverBatch`/`findForOriginalPayment` on the factory-returned instance, and (4) asserts the exact expected persisted-state result. This would run under the existing, previously-approved disposable `postgres:17-alpine` harness (`node scripts/postgres-test-db.mjs --run-tests`), creating and unconditionally removing its own single disposable container exactly as every prior authorized Stage 2 run did — no production, staging, shared, or development-financial database.

```
G11 — BLOCKED: SPECIFIC DATABASE EXECUTION AUTHORIZATION REQUIRED
```

The dependent portions of G03 and G04 (persisted-fixture-result evidence specifically) remain BLOCKED, not VERIFIED. No Docker, container, or PostgreSQL operation was started, connected to, or removed in the course of reaching this decision.

## T. Updated G01–G11 acceptance matrix (final)

| Gate | Disposition | Evidence |
|---|---|---|
| G01 | **VERIFIED** | `getPaymentWebhookService.test.ts` — cold construction succeeds, provider resolved 0 times, `recoverBatch`/`receiveInternalEvent` exposed |
| G02 | **VERIFIED** | `getPaymentRetryService.test.ts` — cold construction succeeds, provider resolved 0 times, `findForOriginalPayment`/`fireDueRetries` exposed |
| G03 | **VERIFIED (construction/exposure/provider-independence)**; **BLOCKED (persisted fixture-result evidence — Section S)** | G01 + source trace (`recoverBatch` never touches `this.deps.provider`) for the verified portion; no real-factory-plus-real-DB test exists for the blocked portion |
| G04 | **VERIFIED (construction/exposure/provider-independence)**; **BLOCKED (persisted fixture-result evidence — Section S)** | G02 + source trace (`findForOriginalPayment` never touches `this.deps.provider`) for the verified portion; same DB gap as G03 |
| G05 | **VERIFIED** | `getPaymentWebhookService.test.ts` G05 — rejects under the provider-unavailable contract, provider resolved only at invocation, not construction |
| G06 | **VERIFIED** | `getPaymentRetryService.test.ts` G06 — fails closed before any due-retry lookup or dispatch |
| G07 | **VERIFIED** | `failedPaymentRetryCoordinatorActivationGate.test.ts` 27/27, `paymentWebhookService.test.ts`'s REM-009 block 18/18, both unmodified |
| G08 | **VERIFIED** | `productionFactoryRecursion.test.ts` 5/5 (provider-available recursion/caching, unmodified) + G01/G02 (provider-unavailable cold construction) + Section P's ACH/debit-card joint-evaluation trace |
| G09 | **VERIFIED**, scope-limited as stated | Diff limited to 3 factory files + 2 test files; zero payment-processing/ledger/payout/schema/migration files changed; 68+77-overlap unit tests pass; no new `createPayment` site; no auth bypass; direct-transfer/payout boundary untouched. Not a claim of complete ledger/settlement/payout certification |
| G10 | **VERIFIED** | Typecheck 0 errors exit 0; lint 0 errors exit 0 (12 pre-existing warnings); full regression 2,248/2,248 pass, exit 0 |
| G11 | **BLOCKED: SPECIFIC DATABASE EXECUTION AUTHORIZATION REQUIRED** (Section S) | G03/G04's persisted-fixture-result portions require a new, separately authorized disposable-PostgreSQL test; not run this round |

**Stage 3 is not marked technically accepted.** G11 remains BLOCKED, and G03/G04 carry an explicit, disclosed partial-BLOCKED status pending that same authorization — per this order's own instruction not to mark the stage accepted while a mandatory gate remains BLOCKED.

## U. Codex handoff (Order 10)

**This is a blocked-stage review, not a request for technical acceptance.** Everything in Sections A–T is available for independent inspection: the complete three-factory diff (two by this agent, one manually by the Project Owner, all now verified compiling and passing), the two new test files (now 4/4 passing, previously 4/4 failing for a real, now-resolved reason), the full focused-test evidence (77/77), typecheck/lint (0 errors each), and the final full regression (2,248/2,248, exit 0, superseding the original 2,244/4-failed/exit-1 result which remains preserved as historical record).

**Supported only by source inspection, not independent execution:** the claim that `recoverBatch`/`receiveInternalEvent`/`findForOriginalPayment` never touch `this.deps.provider` (an exhaustive grep-based trace, not a runtime coverage measurement); the claim that `fireDueRetries`'s guard is evaluated before any database call (verified by reading the method body's statement order, not by instrumenting it); the claim that both `getAchPaymentService()`/`getDebitCardPaymentService()` executed during G02 (inferred from the object-literal's unconditional property evaluation, not from a per-factory call-count spy).

**Source changes made after the final successful regression (Section R):** none. The full regression in Section R was run after the final, accepted state of all three factory files and both new test files; no further edit occurred afterward.

**G11 status for Codex:** BLOCKED — pending a separately authorized disposable-PostgreSQL run, exact scope described in Section S. Codex is not asked to run the non-PostgreSQL suite or the PostgreSQL suite automatically; a focused independent reproduction is appropriate only if Codex identifies a specific material risk or unverified assertion that warrants it, and only under separately authorized execution.

No Stage 4 activity, provider selection, deployment, or real financial operation occurred or is proposed by this addendum.

```
G12 — AWAITING INDEPENDENT CODEX REVIEW
```

## V. Report verification (continuation addendum round)

File: `docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md`. Byte size and SHA-256 (reflecting this file including the continuation addendum) were recorded in the confirmation step immediately following that edit (superseded by the final values in Section AC, which reflect this file including the execution-closure section below).

**Everything above this line, Sections A–V, is preserved exactly as written in the prior two rounds — including the original OUTCOME 3 BLOCKED findings (Sections A–K), the owner's third-factory correction (Sections L–U), and the disclosed G11 database-execution gap (Section S/T). None of it is edited by this addendum.**

---

# EXECUTION CLOSURE ADDENDUM — G03/G04/G11 disposable-PostgreSQL evidence

**PAID2YOU — STAGE 3 FINAL G03/G04/G11 EXECUTION AND EVIDENCE CLOSURE**, followed by **PAID2YOU — STAGE 3 FINAL G03/G04/G11 EXECUTION AND EVIDENCE CLOSURE (corrected re-execution)**. Agent: Claude Code. Mode: execution-and-evidence only — no production, test, or harness source was modified as part of *these two orders*; the harness selector itself (`scripts/postgres-test-db.mjs`) and the two new acceptance tests (`paymentWebhookRecovery.postgres.test.ts`) were added in the immediately preceding round, under a separate, explicit authorization, and are unchanged by this addendum. Generated: 2026-09-22 (continuation of the same engagement, UTC dates now spanning the day boundary from the prior 2026-09-21 rounds).

## W. Two executions, in order

### Attempt 1 — exit 255, no test executed (preserved, not overwritten)

Directory: `docs/remediation/stage03-g03-g04-evidence/run-20260921-155419/` (`command.txt`, `stdout.log`, `stderr.log`). Command: `node scripts/postgres-test-db.mjs --run-tests --stage3-g03-g04-only`. The harness provisioned its container, verified identity, ran migrations, created the runtime role, and passed the scratch check — all correctly. The Vitest child process itself never ran either named test: the `-t` regex's unescaped `|` was interpreted by `cmd.exe` (via `spawnSync(..., { shell: true })`, which Node does not escape array arguments for on Windows) as a shell pipe operator, producing stderr `'STAGE3-G04-REAL-FACTORY-POSTGRES-RETRY-STATUS' is not recognized as an internal or external command` and harness exit 255. Cleanup still ran correctly (container `pay2pay-pgtest-30424-dd7e831e` removed). This was reported in full at the time, and a corrected quoting fix was applied to `scripts/postgres-test-db.mjs` (double-quoting the `-t` pattern on Windows) under that same, already-authorized allowlist — no new file was touched to make this correction.

### Attempt 2 — the corrected, evidence-bearing execution

Directory: `docs/remediation/stage03-g03-g04-evidence/run-20260921-160500-corrected/` (`command.txt`, `stdout.log`, `stderr.log`, `cleanup-verification.txt`).

- **Command:** `node scripts/postgres-test-db.mjs --run-tests --stage3-g03-g04-only`
- **Docker context, verified before the run:** `desktop-linux` (local workstation).
- **Pre-run baseline:** `docker ps -a --filter "label=pay2pay-test-harness=true"` — zero rows.
- **Start (UTC):** `2026-09-22T03:25:30.1572759Z`. **End (UTC):** `2026-09-22T03:25:42.3071015Z`.
- **Container identity:** name `pay2pay-pgtest-25968-f749bf7b`, id `88a268dd8ee1...`, image `postgres:17-alpine`, run token `2f079b9f-64fd-44f5-a61d-675651e9eabd`, published port `127.0.0.1:64507` — all verified via `docker inspect` before any database connection (`stdout.log` lines 1–4).
- **Database identity, verified before any schema/data write:** `current_database=postgres`, `current_user=postgres` (`stdout.log` line 7).
- **Ownership marker:** bootstrapped and immediately verified before migrations (`stdout.log` lines 8–9).
- **Migrations:** all 55 applied cleanly (`stdout.log` line 263).
- **Runtime role:** created, identity/attributes/marker-protection/application-table privileges all verified; harmless scratch write-and-rollback succeeded (`stdout.log` lines 264–278).
- **Selector behavior, this time correct:** the quoting fix worked — the Vitest child ran with the file path and `-t` regex intact, no shell-parsing error. Vitest collected all 159 tests in the one selected file and reports each non-matching one as skipped (`↓`), never executed — this is Vitest's own standard `-t` filtering behavior, not a selection defect.
- **Exact selected-test results:**

| Test identity | Result | Duration | Evidence |
|---|---|---|---|
| `STAGE3-G03-REAL-FACTORY-POSTGRES-RECOVERY` | **FAILED** | 912ms | `stdout.log:339`, `stderr.log:1-20` |
| `STAGE3-G04-REAL-FACTORY-POSTGRES-RETRY-STATUS` | **PASSED** | 220ms | `stdout.log:341` |

- **Vitest final summary (`stdout.log:444-445`):** `Test Files 1 failed (1)`, `Tests 1 failed | 1 passed | 157 skipped (159)`.
- **Harness process exit code:** `1` (`command.txt` line 5) — consistent with one Vitest test failing.
- **Cleanup:** `stdout.log:449` — `stopping and removing this run's own container "pay2pay-pgtest-25968-f749bf7b" (if it exists)`. Independently confirmed by a fresh, separate `docker ps -a --filter "label=pay2pay-test-harness=true"` run immediately afterward (`cleanup-verification.txt`) — zero rows, matching the zero-row pre-run baseline. No unrelated container was inspected or removed; no `docker system prune`/volume/database-deletion command was issued.

**G04's exact failure-free assertion path executed** (`paymentWebhookRecovery.postgres.test.ts`, the `STAGE3-G04...` test body): real committed original payment + retry seeded via `DrizzleFailedPaymentRetryCoordinator.coordinateFailure`; the real, cold `getPaymentRetryService()` singleton's `findForOriginalPayment(payment.id, debtor.userId)` returned the exact seeded retry (`id`, `originalPaymentAttemptId`, `installmentScheduleItemId`, `status: "scheduled"` all matched); the retry row and the agreement's payment-attempt count were byte-identical before and after the call; `SandboxPaymentProvider.prototype.createPayment` was never invoked. This is real, executed, passing evidence — not source inspection.

**G03's exact failure, diagnostic content preserved as-is:** `recovery.claimed` was `>= 1` (the seeded, lease-expired event was correctly reclaimed by `recoverBatch`), but `recovery.processed` was `0`, failing `expect(recovery.processed).toBeGreaterThanOrEqual(1)` at `paymentWebhookRecovery.postgres.test.ts:3029`. `stderr.log` shows the underlying cause the test itself surfaced: `{"level":"error","message":"payment_webhook_processing_failed", ..., "eventType":"payment.succeeded","attempt":2,"retryable":true,"code":"transient_processing_error"}` — the claimed event's `applyEvent` call threw, classified as retryable/transient, incrementing the event to `attempt: 2` (the crashed-claim seed was itself attempt 1) rather than reaching `processed`. **No root-cause diagnosis or fix was attempted** — this order authorizes execution and evidence capture only, explicitly prohibiting production, test, and harness changes; determining why `applyEvent` failed on this specific fixture is out of scope for this round and is recorded here as the next required action.

## X. G03/G04/G11 — updated disposition

| Gate | Disposition | Basis |
|---|---|---|
| G03 | **FAILED** | The named test actually executed (not skipped, not blocked) and its assertion failed against real evidence — `stdout.log:339`, `stderr.log:1-20`, Section W above. Per Order 06, an executed-and-failed assertion is recorded FAILED, not BLOCKED. |
| G04 | **VERIFIED** | The named test actually executed and passed, establishing the exact persisted retry-status lookup through the real factory with zero mutation and zero dispatch — `stdout.log:341`, Section W above. |
| G11 | **FAILED** | G11 requires BOTH named tests to pass; only one did. Isolation, target identity, and cleanup were all independently confirmed for this exact execution (Section W) — the blocker is exclusively G03's real, executed assertion failure, not missing evidence. |

**Sections A–V's prior G01, G02, and G05–G10 dispositions are unchanged and are not contradicted by this round's evidence** — nothing in this execution touched those files or behaviors. **G12 remains `AWAITING INDEPENDENT CODEX REVIEW`.** Stage 3 is not marked technically accepted; G03/G11 are FAILED, not merely blocked on missing evidence, which is a stronger and more specific finding than the prior round's evidentiary gap.

## Y. What was NOT done, per this order's explicit prohibitions

No production source file was modified. No test source file was modified. No harness file was modified. The 2,248-test non-PostgreSQL suite was not rerun. The 281-test (now effectively 159-in-this-file-plus-others) unfiltered PostgreSQL collection was not run. `typecheck`, `lint`, and the production build were not rerun. No other application/test/configuration file was touched. No commit, push, merge, deploy, or Stage 4 activity occurred. The command was executed exactly once after the corrected selector (plus the one earlier, genuinely-failed attempt at the shell-quoting bug, already fully reported) — no automatic retry followed G03's real assertion failure.

## Z. Files this addendum actually changed

Only files created, none of them source:
- `docs/remediation/stage03-g03-g04-evidence/run-20260921-160500-corrected/command.txt`
- `docs/remediation/stage03-g03-g04-evidence/run-20260921-160500-corrected/stdout.log`
- `docs/remediation/stage03-g03-g04-evidence/run-20260921-160500-corrected/stderr.log`
- `docs/remediation/stage03-g03-g04-evidence/run-20260921-160500-corrected/cleanup-verification.txt`
- `docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md` (this addendum)

The prior round's `scripts/postgres-test-db.mjs` selector fix and the two new tests in `paymentWebhookRecovery.postgres.test.ts` were made in the immediately preceding, separately authorized round — not by this execution-and-evidence order — and remain unmodified here.

## AA. Remaining owner decision

**G03's `applyEvent` failure on this exact fixture is a genuine, real, database-executed finding requiring its own diagnosis.** The next action is a separately authorized *diagnostic* round (source inspection plus, if needed, further disposable-PostgreSQL reproduction) to determine why a `payment.succeeded` event recovered from a crashed/lease-expired claim, for a freshly seeded `pending`-status payment attempt, is throwing an exception inside `applyEvent` that `classifyProcessingFailure` labels `transient_processing_error` — this round did not, and was not authorized to, investigate further.

## AB. G12

```
G12 — AWAITING INDEPENDENT CODEX REVIEW
```

Handoff addendum for Codex: Sections W–AA above, plus the four evidence files in `docs/remediation/stage03-g03-g04-evidence/run-20260921-160500-corrected/` and the preserved failed-attempt evidence in `docs/remediation/stage03-g03-g04-evidence/run-20260921-155419/`. This is a mixed result, not a clean pass — G04/G11-relevant-half VERIFIED by real execution, G03/G11 FAILED by real execution, with the underlying cause disclosed but not diagnosed. No claim of Stage 3 acceptance is made.

## AC. Report verification (execution-closure round)

File: `docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md`. Byte size and SHA-256 recorded in the confirmation step immediately following that edit (superseded by the final values in Section AJ, which reflect this file including the migration-remediation section below).

**Everything above this line, Sections A–AB, is preserved exactly as written across the prior three rounds and is not edited by this addendum.**

---

# MIGRATION REMEDIATION ADDENDUM — G03/G04/G11 resolved

**PAID2YOU — STAGE 3 G03 PAYOUT-ATTEMPT MIGRATION REMEDIATION.** Agent: Claude Code. Mode: one narrowly scoped new migration, verified against the two existing Stage 3 acceptance tests via one authorized disposable-PostgreSQL execution. Generated: 2026-09-22.

## AD. Historical chronology (unchanged, restated for continuity)

1. Initial PostgreSQL invocation failed with Windows exit 255 (unescaped `|` interpreted as a shell pipe) — Section W, Attempt 1.
2. Corrected invocation executed both tests — Section W, Attempt 2.
3. G03 failed during `applyEvent` (`recovery.processed` stayed `0`) — Section X.
4. G04 passed — Section X.
5. Isolation and cleanup succeeded for that corrected run regardless of G03's failure — Section W.
6. Subsequent read-only source diagnosis (separate order) traced the failure to `recordPayoutOwedRequired` → `PayoutService.recordPayoutOwed` → an INSERT into `payout_attempt`, and confirmed via direct migration-file inspection that no migration under `supabase/migrations/` created that table — classified **D. EXISTING ENVIRONMENT OR DATABASE PRECONDITION DEFECT**, with the exact exception text explicitly disclosed as NOT CAPTURED in the available logs.
7. This round: one new migration was authored, and one new authorized execution round produced the results below.

## AE. Schema gap, confirmed before writing SQL

`src/db/schema/payoutAttempt.ts:27-51` defines `pgTable("payout_attempt", {...}).enableRLS()` with columns `id`/`payment_attempt_id`/`agreement_id`/`status`/`created_at`/`confirmed_at`/`provider_name`/`provider_payout_reference`/`failed_at`/`failure_reason`/`returned_at`/`return_reason`, a NOT NULL FK to `payment_attempt.id`, a NOT NULL FK to `agreement.id`, and a named unique index `payout_attempt_payment_attempt_id_unique` on `payment_attempt_id`. The enum is `src/db/schema/enums.ts:811`: `pgEnum("payout_attempt_status", ["pending", "confirmed", "failed", "returned"])`.

`ls supabase/migrations/*.sql | wc -l` (before this round) = 55, latest `20260915030000_sms_consent.sql`. `grep -r "payout_attempt" supabase/migrations` (before this round) = zero matches, confirmed independently a second time this round before writing SQL. Compared against the closest existing precedent (`payment_attempt`'s own creation in `20260811131000_sprint9_payment_provider_kyc.sql:2-20`, and the FK/unique-index/RLS pattern in `20260901020000_agreement_party_snapshot_personal_profile_identity.sql:1-28`): every existing table of this kind is created with a plain `CREATE TABLE`, separate `ALTER TABLE ... ADD CONSTRAINT ..._fk FOREIGN KEY ... REFERENCES "public"."<table>"("id") ON DELETE no action ON UPDATE no action`, an explicit `CREATE UNIQUE INDEX` where the schema names one, and a trailing `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` — **no migration in this repository creates an explicit GRANT or RLS policy**; access is left default-deny under RLS, exactly mirroring `payment_attempt`/`payment_webhook_event`/`agreement_party_snapshot` and every other financial/PII table. The new migration replicates this exact, established convention — no ownership, grant, or policy statement was invented, and none was needed to satisfy the acceptance tests (the disposable harness's own runtime role already receives its DML grants schema-wide, on `ALL TABLES IN SCHEMA public`, applied after migrations, unaffected by RLS since the harness's own disclosed `BYPASSRLS` exception applies).

## AF. Migration created

**File:** `supabase/migrations/20260922000000_payout_attempt.sql` — the only new file, later than every existing migration (56th of 56), matching the repository's `YYYYMMDDHHMMSS_description.sql` naming convention.

```sql
CREATE TYPE "public"."payout_attempt_status" AS ENUM('pending', 'confirmed', 'failed', 'returned');--> statement-breakpoint
CREATE TABLE "payout_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"status" "payout_attempt_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"provider_name" text,
	"provider_payout_reference" text,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"returned_at" timestamp with time zone,
	"return_reason" text
);
--> statement-breakpoint
ALTER TABLE "payout_attempt" ADD CONSTRAINT "payout_attempt_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_attempt" ADD CONSTRAINT "payout_attempt_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_attempt_payment_attempt_id_unique" ON "payout_attempt" USING btree ("payment_attempt_id");--> statement-breakpoint
ALTER TABLE "payout_attempt" ENABLE ROW LEVEL SECURITY;
```

No previously applied migration was modified. No `DROP TABLE`/`DROP TYPE` appears anywhere in it. No column, type, nullability, default, or constraint was invented beyond the existing `payoutAttempt.ts`/`enums.ts` definitions. This migration has been applied only inside the disposable PostgreSQL harness (Section AG) — it has not been applied to, and this round did not authorize applying it to, any production, staging, shared, or development-financial database.

## AG. The one authorized execution

Directory: `docs/remediation/stage03-g03-g04-evidence/run-20260922-migration-fix/` (`command.txt`, `stdout.log`, `stderr.log`, `cleanup-verification.txt`). Prior evidence (`run-20260921-155419/`, `run-20260921-160500-corrected/`) preserved untouched.

- **Command:** `node scripts/postgres-test-db.mjs --run-tests --stage3-g03-g04-only`
- **Docker context, verified before the run:** `desktop-linux`.
- **Pre-run baseline:** zero harness-labeled containers.
- **Start (UTC):** `2026-09-22T03:36:58.1602407Z`. **End (UTC):** `2026-09-22T03:37:10.3380161Z`.
- **Container identity:** name `pay2pay-pgtest-4704-6389f02c`, id `1e07038f0d90...`, image `postgres:17-alpine`, run token `00138dfc-869d-4010-853d-5998307f97d1`, published port `127.0.0.1:57192` — verified via `docker inspect` before any database connection (`stdout.log:1-4`).
- **Database identity, verified before any schema/data write:** `current_database=postgres`, `current_user=postgres` (`stdout.log:7`).
- **Ownership marker:** bootstrapped and verified before migrations (`stdout.log:8-9`).
- **Migrations:** **all 56 applied cleanly** — `stdout.log:263`: `[fresh-migration-test] OK — all 56 migrations applied cleanly to an empty database.` (55 pre-existing + the one new `20260922000000_payout_attempt.sql`, confirming it applied without error alongside every prior migration, unmodified).
- **Runtime role, scratch check:** verified and succeeded, unchanged pattern from every prior round.

**Exact selected-test results:**

| Test identity | Result | Duration | Evidence |
|---|---|---|---|
| `STAGE3-G03-REAL-FACTORY-POSTGRES-RECOVERY` | **PASSED** | 1026ms | `stdout.log:345` |
| `STAGE3-G04-REAL-FACTORY-POSTGRES-RETRY-STATUS` | **PASSED** | 190ms | `stdout.log:346` |

- **Vitest final summary (`stdout.log:449-450`):** `Test Files 1 passed (1)`, `Tests 2 passed | 157 skipped (159)` — the same 157 tests skipped by the fixed name filter as every prior round; neither acceptance test was skipped.
- **Harness process exit code:** `0` (`command.txt`).
- **stderr.log:** only the pre-existing, unrelated Node `DEP0190` deprecation notice — no test failure, no error log line (contrast with the prior round's `payment_webhook_processing_failed` entry, now absent).
- **Cleanup:** `stdout.log:454` — container `pay2pay-pgtest-4704-6389f02c` stopped and removed. Independently confirmed by a fresh, separate `docker ps -a --filter "label=pay2pay-test-harness=true"` run immediately afterward (`cleanup-verification.txt`) — zero rows, matching this round's own zero-row pre-run baseline. No unrelated container, volume, or image was inspected or removed.

**G03's full assertion path now passes against real PostgreSQL:** `recovery.claimed >= 1` and `recovery.processed >= 1` both true; `payment.status === "succeeded"`; exactly one `payment_cleared` ledger entry; the webhook event `processingStatus === "processed"` with a non-null `processedAt`; `SandboxPaymentProvider.prototype.createPayment` never invoked. This includes the real, previously-failing `recordPayoutOwedRequired` → `payoutAttempts.insert(...)` write, now succeeding against the newly migrated `payout_attempt` table.

## AH. G03/G04/G11 — final disposition

| Gate | Disposition | Basis |
|---|---|---|
| G03 | **VERIFIED** | The named test actually executed and passed against real PostgreSQL, with the exact expected persisted financial effects — `stdout.log:345`, Section AG. |
| G04 | **VERIFIED** | Unchanged from the prior round — the named test actually executed and passed (re-confirmed passing again this round, `stdout.log:346`). |
| G11 | **VERIFIED** | Both named tests passed in the same execution; isolation (container/database identity, ownership marker, loopback target, local Docker context), harness exit code 0, and independently confirmed exact-container cleanup are all established from this one execution's own evidence (Section AG). |

**Sections A–AB's prior G01, G02, and G05–G10 dispositions are unchanged and are not contradicted by this round.** **G12 remains `AWAITING INDEPENDENT CODEX REVIEW` — this addendum does not claim independent Codex acceptance or Project Owner acceptance.** With G01–G11 now all VERIFIED, the results are ready for independent Codex verification, but Stage 3 technical acceptance itself remains Codex's and then the Project Owner's decision, not Claude's to declare.

## AI. Files this addendum actually changed

- `supabase/migrations/20260922000000_payout_attempt.sql` (new — the only production/schema file touched)
- `docs/remediation/stage03-g03-g04-evidence/run-20260922-migration-fix/command.txt`
- `docs/remediation/stage03-g03-g04-evidence/run-20260922-migration-fix/stdout.log`
- `docs/remediation/stage03-g03-g04-evidence/run-20260922-migration-fix/stderr.log`
- `docs/remediation/stage03-g03-g04-evidence/run-20260922-migration-fix/cleanup-verification.txt`
- `docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md` (this addendum)

No production TypeScript file, no existing migration, no Drizzle schema file, no test source, no harness file, no Vitest configuration, and no Codex report was modified. No commit, push, merge, deploy, or Stage 4 activity occurred.

## AJ. Report verification (final)

File: `docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md`. Byte size and SHA-256 recorded in the confirmation step immediately following this edit.

*End of report.*
