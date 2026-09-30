# Stage 2 — Final Pre-Authorization Clarification

**STAGE 2 — FINAL PRE-AUTHORIZATION CLARIFICATION**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: read-only clarification only.
No Docker container was started. No PostgreSQL connection occurred. No test requiring a database was run. `--run-tests` was not invoked. No production code was modified. This response is not treated as authorization for the supplemental validation run, and none was executed. Generated: 2026-09-19.

---

## Question 1 — the `pay2pay-pgtest-24592-3d4e3c98` reference in the Supplemental report

**The reference is accurate, not erroneous. It is not concealed, and it does not describe an unauthorized run as authorized.**

`docs/remediation/STAGE_02_PHASE_B_SUPPLEMENTAL_EVIDENCE_AND_AUTHORIZATION.md`, Section A, closes with:

> *"No prior command output is rewritten. No result is manufactured from the now-deleted container (`pay2pay-pgtest-10604-0b5a466b` from the original Phase B run, or `pay2pay-pgtest-24592-3d4e3c98` from the subsequent Phase C run) — both are gone, and nothing in this document claims otherwise or attributes any new evidence to either of them."*

This sentence names **two different, both real, both separately authorized** prior executions, purely to establish that the Supplemental report manufactures evidence from **neither** of them. `pay2pay-pgtest-24592-3d4e3c98` is not attributed to Phase B anywhere in that document — it is explicitly labeled "from the subsequent Phase C run" in the same sentence it appears in.

**Full account of that execution, as requested:**

| Item | Value |
|---|---|
| Exact command executed | `node scripts/postgres-test-db.mjs --run-tests` |
| Purpose | Execute the real, disposable-PostgreSQL REM-008 acceptance test suite (`*.postgres.test.ts`) — Stage 2 Phase C |
| Authorization | The Project Owner's own message beginning *"I acknowledge and accept the Stage 2 Gate B PASS documented in STAGE_02_PHASE_B_ISOLATION_AND_HARNESS_EVIDENCE.md. You are authorized to execute Stage 2 Phase C exactly once using: node scripts/postgres-test-db.mjs --run-tests..."* — a distinct, explicit, prior authorization, separate from and issued after the original Phase B validation-only authorization |
| Was `--run-tests` invoked? | **Yes** — explicitly, by name, exactly as that authorization specified |
| Results | Exit code `1` (nonzero, reflecting 2 genuine test failures — not a harness or cleanup defect); 7 of 8 existing `*.postgres.test.ts` files ran; **279 of 281 tests passed**; 2 failed (`TEST 008-I`, a new Stage 2 test, and `R-B51`, a pre-existing, unrelated test); container `pay2pay-pgtest-24592-3d4e3c98` (run token `9a0309a9-daa0-48d4-bfb9-1782c3502cbd`, port `52561`) was confirmed fully removed afterward |
| Complete report location | `docs/remediation/STAGE_02_PHASE_C_REM008_POSTGRESQL_EXECUTION_REPORT.md` (the original execution results) and `docs/remediation/STAGE_02_PHASE_C_FAILURE_DIAGNOSIS.md` (the subsequent, separately-authorized diagnostic round that root-caused both failures — itself using three further, independently authorized-under-its-own-order disposable containers, none of which is `pay2pay-pgtest-24592-3d4e3c98`) |

**No addendum correcting this reference is required or produced**, per this order's own conditional ("If the reference is erroneous... correct the statement") — it is not erroneous. No execution is concealed: this document restates, rather than hides, that a real, authorized, `--run-tests` execution occurred, with real failures, fully reported at the time.

---

## Question 2 — `performHarmlessScratchOperation`'s same-connection/same-transaction guarantee

**Exact source (`scripts/postgres-test-db.mjs`):**

| Line(s) | Statement |
|---|---|
| 734 | `const runtimeVerifySql = postgres(runtimeDatabaseUrl, { max: 1, prepare: false, connect_timeout: 5 });` — the connection handle, created **once**, with `max: 1` |
| 757 | `const scratchResult = await performHarmlessScratchOperation({ sql: runtimeVerifySql });` — this exact handle is passed in as `sql` |
| 518 | `await sql\`BEGIN\`;` |
| 523 | `const insertedRows = await sql.unsafe(\`INSERT INTO ${SCRATCH_TABLE_NAME} (note) VALUES ($1) RETURNING id, note\`, [testNote]);` |
| 528 | `const visibleRows = await sql.unsafe(\`SELECT id FROM ${SCRATCH_TABLE_NAME} WHERE note = $1\`, [testNote]);` — the in-transaction observation |
| 534 | `await sql\`ROLLBACK\`;` — inside a `finally` block (517–535) |
| 536 | `const afterRollbackRows = await sql.unsafe(\`SELECT id FROM ${SCRATCH_TABLE_NAME} WHERE note = $1\`, [testNote]);` — the post-rollback observation |
| 763 | `await runtimeVerifySql.end({ timeout: 1 }).catch(() => {});` — the same handle is closed only after every check (including this operation) completes |

**Proof that BEGIN/INSERT/SELECT/ROLLBACK share one connection and one transaction:**

1. **One client object, never re-created.** `runtimeVerifySql` is constructed exactly once (line 734) and is the single object threaded through every verification call in that block, including `performHarmlessScratchOperation`. `performHarmlessScratchOperation` itself never constructs a `postgres(...)` client — it only ever calls methods (`sql\`...\``, `sql.unsafe(...)`) on the object handed to it.
2. **`{ max: 1 }` caps the underlying pool at exactly one physical connection.** This is the identical, already-relied-upon pattern this repository uses elsewhere for the same reason — `test/postgres/testDb.ts`'s own `createIsolatedDb` doc comment states plainly that a `max: 1` client gives "its own TCP socket, its own backend process," and every other identity-check connection this file opens (`identitySql` at line ~536 of the earlier-added code, `roleSql`) uses the identical `{ max: 1, prepare: false }` shape for the same guarantee. With `max: 1`, the `postgres` npm package never opens a second physical connection for a later query on the same client — every query issued through `runtimeVerifySql` is routed to that one session.
3. **Every statement is `await`-ed strictly in sequence**, with no `Promise.all` or other concurrent dispatch anywhere in the function (lines 514–544) — so the five statements (`BEGIN`, `INSERT`, in-transaction `SELECT`, `ROLLBACK`, post-rollback `SELECT`) reach the server in exactly that textual order, on that one session. PostgreSQL's transaction state (opened by `BEGIN`, ended by `ROLLBACK`) is a property of the session itself — since all five statements provably share one session, the transaction boundary is exactly what the source text says it is.
4. **`sql.unsafe(text, params)` does not change connection binding** — it is a query-construction method on the same client object, not a separate connection or a separate client; it shares the identical pool/session as the tagged-template form (`sql\`...\``) on the same object.

**Rollback guarantee on intermediate failure:** lines 517–535 wrap `BEGIN`, `INSERT`, and the in-transaction `SELECT` in a `try { ... } finally { await sql\`ROLLBACK\`; }`. JavaScript's `try/finally` guarantees the `finally` block executes whether the `try` block completes normally, throws a real database error (e.g., a constraint violation on `INSERT`), or throws one of this function's own explicit assertion errors (lines 526, 530 — a mismatched read-back, or an unexpected row count). In every one of those cases, `ROLLBACK` is issued next, before any other statement on this connection, and before the exception is allowed to propagate further. The outer `try/catch` (lines 516, 541–543) then converts whatever escapes into `{ ok: false, reason }` rather than letting it throw out of the function.

**One honestly-disclosed edge case, not a defect:** if `ROLLBACK` itself were to throw (for example, because the connection had already been severed by whatever caused the original failure, leaving no live transaction to roll back), JavaScript's `finally`-throws-during-unwind semantics mean that new error — not the original one — is what propagates to the outer `catch`. The function still correctly returns `{ ok: false, reason: <...> }` in that case (a failure is never silently swallowed or reported as success), but the reported message would describe the `ROLLBACK` failure rather than the original cause. This is disclosed for completeness; it does not weaken the core guarantee this question asks about (the operation never reports success while an error occurred, and no code path skips attempting `ROLLBACK`).

**Post-rollback SELECT freshness:** the query at line 536 executes only after the inner `try/finally` (including its `ROLLBACK`) has fully completed — it is a distinct round-trip issued on the same session, in whatever ordinary (autocommit, no open transaction) state follows a `ROLLBACK`. Under PostgreSQL's default `READ COMMITTED` isolation (nothing in this code requests a stricter level), a new statement always observes the latest committed state at the moment it starts; since the `INSERT` was never committed, this `SELECT` correctly and necessarily observes its absence. This is standard, well-documented PostgreSQL behavior, not a subtle or questionable claim.

**Scope of this proof:** this is a **static, source-and-documentation-based proof**, citing the exact lines above and the `postgres` npm package's own documented `max` option semantics — consistent with this clarification's own instruction not to execute any database operation. It has not been additionally re-confirmed by a real execution in this round (the function has been offline-tested against fakes — Section D of the prior Gate B evidence report — but not yet run against a real disposable database at all, a fact that report itself disclosed and this clarification does not overstate).

**Conclusion: the implementation already guarantees the properties this question asks about.** Per this order's own conditional ("If the implementation cannot guarantee these properties, correct only the test harness and its offline tests"), **no correction was made** — none is needed. No file was changed as part of answering this question.

---

## Verification

This document itself: existence, byte size, and SHA-256 are recorded in the confirmation step immediately following its creation (see the chat response), not asserted in advance of that check.

No file other than this report was created or modified in the course of answering either question. `git rev-parse HEAD` is unchanged. No container was created. No `--run-tests` or database-dependent command was executed.

*End of report.*
