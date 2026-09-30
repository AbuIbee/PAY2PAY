# Control Order 004-B — Final Report

**SV-007 factory-test correction (ownership-scoped identification + parenthesized-expression handling)**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Branch: `architecture/bank-managed-payments-v3`
Previous audit: 004-V (SV-006 VERIFIED AND CLOSED; SV-007 FAILED) · Generated: 2026-09-17

---

## 1. Exact preflight state

- Directory: `C:\Development\PAY2PAY-bank-v3` (confirmed).
- Branch: `architecture/bank-managed-payments-v3` (confirmed).
- HEAD: `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` — unchanged before and after this order.
- `git status --porcelain` line count: 79 both before and after this order's edits (no file added to or removed from the status list — only the content of already-modified/-untracked files A and B changed further).
- No `.git` lock file; no evidence of concurrent modification.
- `CLAUDE.md` (this worktree's own): confines work to `C:\Development\PAY2PAY-bank-v3`, names `docs/PAY2PAY_MASTER_SPEC.md` as canonical, requires one-phase-at-a-time execution and a documentation update after each phase. `AGENTS.md`: unrelated Next.js dev-tooling boilerplate, no conflict.
- **Master-spec conflict check:** `docs/PROGRESS.md` tracks completion by numbered "Sprint," gated on explicit ChatGPT/Product-Owner review and commit authorization per `docs/SPRINT_CONTROL.md`. This narrowly-scoped SV-007 test correction is not itself a new Sprint and does not fit that table's schema — no material conflict requiring a stop, but appending a "Control Order 004-B" row to the Sprint table would misrepresent it as a Sprint. Resolution: the documentation-update obligation is satisfied by this report file itself (see Section 13), not by editing `docs/PROGRESS.md`'s Sprint table.
- Actual current source inspected before any edit:
  - `getFailedPaymentRetryCoordinator.ts`: unchanged from 004-A — `export function getFailedPaymentRetryCoordinator()`, module-level `let cached: FailedPaymentRetryCoordinator | null = null;`, `if (!cached) { cached = new DrizzleFailedPaymentRetryCoordinator(..., getServerEnv().PAYMENT_INITIATION_VERIFIED); } return cached;`. Confirmed correct — **not modified**.
  - `failedPaymentRetryCoordinator.ts`: constructor signature unchanged from 004-A (SV-006 already closed). Two comments contained stale `55` totals (lines ~708, ~738) — corrected per Section 3.B below.
  - `failedPaymentRetryCoordinatorActivationGate.test.ts`: contained the defective `findProductionFactoryCoordinatorCall` (file-wide, ownership-blind, no paren-unwrapping) — the actual defect this order corrects.
- No material difference from the structure Codex reported; no scope-amendment needed.

---

## 2. Files actually changed

- `src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts` — test code only (Section 3.A). `findProductionFactoryCoordinatorCall` rewritten; regression fixtures for R1–R13 added; former NC-006 reconciled per Section 6.
- `src/lib/failedPayments/failedPaymentRetryCoordinator.ts` — comment-only correction (Section 3.B): two stale `55` totals corrected to the recounted `57 executable / 4 compile-only / 61 total`. No executable code, constructor signature, or call site changed.
- New: `docs/remediation/CONTROL_ORDER_004-B_SV-007_FACTORY_TEST_CORRECTION.md` — this report (Section 3.C / Section 10).

No other file was touched. `getFailedPaymentRetryCoordinator.ts` was inspected and left unmodified (no defect found). No sibling worktree or Downloads path was accessed.

---

## 3. Before-and-after identification logic

**Before (defective):** any `new DrizzleFailedPaymentRetryCoordinator(...)` node, anywhere in the file, whose direct `.parent` was a `BinaryExpression` (`=`) with an identifier named `cached` on the left. Two defects: (a) checking `.parent` directly means a `(new X(...))` parenthesized call's parent is the `ParenthesizedExpression`, not the assignment, so a parenthesized production call was invisible to the check; (b) matching was based purely on the text `cached`, anywhere in the file, regardless of which function the assignment lived in.

**After (corrected):**
1. Locate the actual exported `function getFailedPaymentRetryCoordinator` declaration by name — establishing which function *is* the factory before inspecting any constructor expression.
2. Read that function's own `return <identifier>;` statement to identify its cache-binding return flow.
3. Search only the factory's own top-level statements (recursing through blocks/if-statements, but never descending into a nested function/arrow/method boundary) for an assignment to that same identifier, unwrapping any `ParenthesizedExpression` wrapper on the right-hand side before checking whether the result is the `DrizzleFailedPaymentRetryCoordinator` constructor.
4. Zero or more than one qualifying assignment inside the factory throws (fails closed) — ambiguity is never silently resolved, and an assignment in any other function is structurally invisible regardless of its variable name.

The 7-argument / 7th-argument structural assertion (`assertSeventhArgumentIsPaymentInitiationVerified`) is unchanged from 004-A — it already satisfied requirements B–G and needed no correction.

---

## 4. How factory ownership and cache-binding identity are established

Ownership is established purely by which function's own AST subtree an assignment statement lives in — determined by starting the search at the named `FunctionDeclaration`'s `body` and refusing to recurse into any nested `FunctionDeclaration`/`FunctionExpression`/`ArrowFunction`/`MethodDeclaration` node encountered along the way. This is what makes R7/R8's differently-named unrelated functions and R9's nested decoy function structurally invisible, without needing full type-checker symbol resolution: two functions never share an AST subtree, and a nested function's body is explicitly excluded from the parent's own traversal. The cache-binding identity is the identifier named in the factory's own `return <identifier>;` statement — read once per source, then used as the exact match key for the assignment search, so the helper is not hardcoded to the literal string `cached` (a different-but-equivalent production variable name would still be identified correctly).

---

## 5. How parenthesized expressions are handled

`unwrapParens` strips any number of nested `ParenthesizedExpression` wrappers from the right-hand side of a matched assignment before checking whether the remaining expression is a `NewExpression` for `DrizzleFailedPaymentRetryCoordinator`. This runs *after* the assignment target is confirmed to match the factory's own returned identifier, so parentheses around the real production call no longer hide it (R4), and parentheses cannot be used to smuggle a decoy past the check either — the unwrapped expression is still required to be exactly a `DrizzleFailedPaymentRetryCoordinator` `NewExpression`.

---

## 6. Results R1–R13

All fixtures for R2, R3, R4 and R9 are built by parsing the REAL, on-disk `getFailedPaymentRetryCoordinator.ts` source and applying AST-located character-offset splices (never a string search for the argument's own text, and never mutating the on-disk file itself).

| Case | Fixture | Expected | Actual |
|---|---|---|---|
| R1 (TEST 008-J) | Real, unmodified factory source | PASS | **PASS** |
| R2 | Real factory, 7th arg replaced with `true` | FAIL | **FAIL** — `"hardcoded literal \`true\`"` |
| R3 | Real factory, 7th arg → `true`, constructor wrapped in parens, PLUS an unrelated function with its own correctly-configured `cached =` assignment (exact Codex false-pass reproduction) | FAIL | **FAIL** — `"hardcoded literal \`true\`"`, correctly identifying the real (parenthesized, broken) production assignment rather than the unrelated correct one |
| R4 | Real factory, correct construction wrapped in parens only | PASS | **PASS** |
| R5 | Factory returns `cached`, but only `decoyCached` is constructed inside it | FAIL | **FAIL** — `"No \`cached = new DrizzleFailedPaymentRetryCoordinator...\` assignment found..."` |
| R6 | Two `cached =` constructions directly inside the factory's own if/else | FAIL | **FAIL** — `"Ambiguous: found 2 candidate..."` |
| R7 | Correct production construction + unrelated differently-named function with its own correct construction | PASS | **PASS** |
| R8 | Correct production construction + unrelated differently-named function with an incorrect construction | PASS | **PASS** |
| R9 | Real factory, 7th arg → `true`, PLUS a nested decoy function (declared inside the factory's own body) with a correctly-configured construction | FAIL | **FAIL** — `"hardcoded literal \`true\`"`, correctly ignoring the nested decoy |
| R10 | 7th arg = `getServerEnv().SOME_OTHER_FLAG` | FAIL | **FAIL** — `"SOME_OTHER_FLAG"` |
| R11 | 6 arguments | FAIL | **FAIL** — `"Expected exactly 7 constructor arguments"` |
| R12 | 7th arg = `true`, correct expression only in a comment | FAIL | **FAIL** — `"hardcoded literal \`true\`"` |
| R13 | 7th arg = `true`, correct expression present elsewhere in the file | FAIL | **FAIL** — `"hardcoded literal \`true\`"` |
| R6-reconciliation (formerly NC-006) | Correct production factory + a differently-named function reusing the same `cached` variable name for its own (incorrect) construction | PASS (corrected expectation — see Section 7) | **PASS** |

All 14 results match their specified expectation exactly.

---

## 7. Explicit demonstration that Codex's original false-pass mutation is rejected

R3 is the literal reproduction Codex specified: the real production constructor wrapped in parentheses, its actual 7th argument changed to `true`, plus an unrelated function containing its own correctly-configured `cached = new DrizzleFailedPaymentRetryCoordinator(...)`. Under the previous helper this fixture would PASS (the parenthesized real assignment was invisible to the parent check; the unrelated correct assignment, matched purely by the variable name `cached`, would be — and in one earlier manual trace, was — selected instead). Under the corrected helper, the search never leaves the real, named `getFailedPaymentRetryCoordinator` function's own body, so the unrelated function's assignment is never a candidate at all; the parenthesized real assignment is unwrapped and correctly identified; its 7th argument is `true`; the test throws `"hardcoded literal \`true\`"` and the assertion `expect(...).toThrow(/hardcoded literal \`true\`/)` passes. R3 is green in the actual test run recorded in Section 8.

---

## 8. Exact commands, exit statuses and test counts

| Step | Command | Result |
|---|---|---|
| 1 | `npx vitest run src/lib/failedPayments/failedPaymentRetryCoordinatorActivationGate.test.ts` | **19/19 pass**, exit 0 (5 pre-existing 008-A/B/D/E/direct-invocation + 14 new/rewritten R1–R13 + reconciliation) |
| 2 | `npm run typecheck` (`tsc --noEmit`) | **0 errors**, exit 0 |
| 3 | `npx vitest run src/lib/failedPayments/productionFactoryRecursion.test.ts` | **5/5 pass**, exit 0 — file not modified this order |
| 4 | `npm run lint` | **0 errors**, 12 pre-existing warnings (identical set to before this order, none in the two authorized files), exit 0 |
| 5 | `npx vitest run` (full non-Postgres suite) | **257/257 files, 2224/2224 tests pass**, exit 0, single run — no failures, no retry needed |

Production build: **not run** — this order authorizes test and comment changes only, and no executable production code changed, so per Section 8 a new build is not mandatory. (For continuity: the prior order, 004-A, ran `npm run build` successfully against the then-current `failedPaymentRetryCoordinator.ts`; that file's only change this round was two comments.)

No PostgreSQL tests were run. No database connection, staging environment, or live payment provider was accessed.

---

## 9. Failed initial runs and retries

None. Every command in Section 8 passed on its first execution; no retry was required.

---

## 10. Final Git status

```
Branch: architecture/bank-managed-payments-v3
HEAD:   93bbbbf8950010d4c0a70c7133339dc352ebd0fd   (unchanged — no commit made)
```

`git status --porcelain` line count: 79, identical to the preflight count — no file was added to, or removed from, the tracked/untracked/staged sets, except the new report file itself (`docs/remediation/CONTROL_ORDER_004-B_SV-007_FACTORY_TEST_CORRECTION.md`), which is additive documentation, not code. No commit, push, merge, rebase, reset, stash, or branch/worktree change was performed. The reference worktree (`PAY2PAY-b0d-integration`) and Downloads were not accessed under this order.

---

## 11. Confirmation that production code and financial behavior were not changed

`getFailedPaymentRetryCoordinator.ts` was not modified. `failedPaymentRetryCoordinator.ts`'s only change was to two code comments (stale call-site totals) — no line of executable logic, no constructor signature, no method body, no guard condition changed. `DrizzlePaymentInitiationEligibilityService`, `PaymentRetryService`, provider interfaces, ledger/payout code, schema, and CI/scanner configuration were not touched. The activation gate's runtime behavior (verified unchanged by Step 1's unmodified TEST 008-A/B/D/E and the direct-invocation test, all still passing) is identical to the state 004-A left it in.

---

## 12. Remaining limitations

- PostgreSQL-dependent requirements (008-C/F/G/H/I) remain unauthorized and unexecuted under this order, exactly as under 004-A.
- REM-009 remains architecturally BLOCKED, unchanged.
- REM-001/REM-002 remain deferred per Architectural Control Change 003.
- This order did not run `npm run build`; the last confirmed successful build is from 004-A, against a `failedPaymentRetryCoordinator.ts` whose only subsequent change is two comments.

---

## 13. Mandatory project-documentation update

Per `CLAUDE.md`'s "Update the project documentation after each phase": `docs/PROGRESS.md` tracks completion strictly by numbered Sprint, gated on explicit product-owner review (see Section 1's conflict note) — this point-fix does not correspond to a Sprint and appending it to that table would misrepresent it as one. The documentation update for this phase is this report itself: `docs/remediation/CONTROL_ORDER_004-B_SV-007_FACTORY_TEST_CORRECTION.md`, newly created, placed alongside the repository's existing `docs/remediation/` material. No other documentation file required a change.

---

## OVERALL STATUS

**SV-007: COMPLETE.** The acceptance gate (Section 9, items A–J) is satisfied: the actual production factory is identified by name and return-flow, not by an unrelated constructor (A); Codex's exact false-pass mutation (R3) now fails (B); the correct, parenthesized production construction passes (C); missing or ambiguous real-factory construction fails (D, R5/R6); every other regression control (R7, R8, R10–R13, the R6-reconciliation) produces its specified result (E); the pre-existing authorization tests and the factory-recursion suite continue passing unmodified (F); typecheck and lint pass with no new errors (G); the complete non-PostgreSQL suite passes in full (H); no production payment behavior was modified (I); the change boundary — files A and B, plus this report — was respected (J).

This is Claude's own assessment of the evidence gathered; per this order's own instruction, **SV-007 is not declared independently VERIFIED** — that determination belongs to Codex's independent audit.

**Overall REM-008 remains PARTIAL** — not VERIFIED — pending the separately-authorized, still-unexecuted PostgreSQL-dependent requirements and REM-009's architectural blocker, neither of which this order addressed.

*End of report.*
