# Stage 2 — Phase B Supplemental Evidence and Authorization

**PAID2YOU — STAGE 2 GATE B FINAL EVIDENCE COMPLETION**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: focused offline implementation and report preparation only.
No Docker container was started or created. No PostgreSQL connection, migration, role creation, or write occurred. `npm run test:postgres` and `--run-tests` were not invoked. No production, development, shared, or hosted database was accessed. No real provider was contacted. Generated: 2026-09-19.

This document serves two purposes at once, per this order's own structure: (A) it is the addendum correcting the original Phase B evidence report's classification (ORDER 01) — the original report `docs/remediation/STAGE_02_PHASE_B_ISOLATION_AND_HARNESS_EVIDENCE.md` is **not modified, not overwritten, and its successful results are not recharacterized as failures**; and (B) it is the supplemental authorization packet (ORDER 05) for the one new capability now implemented but not yet executed.

---

## A. Corrected Gate B evidence classification (ORDER 01)

The original Phase B run (documented, unchanged, in the original report) genuinely and successfully exercised, against a real disposable PostgreSQL instance:

| Requirement | Actually exercised against real PostgreSQL? |
|---|---|
| Host-side container identity (`docker inspect`) | **Yes** — real `docker inspect` output, real container |
| In-database identity (`current_database`/`current_user`, bootstrap connection) | **Yes** — real query, real result |
| Ownership-marker bootstrap and verification, before migrations | **Yes** — real `INSERT`/`SELECT` |
| Migration application (55 migrations) | **Yes** — real `apply-migrations-fresh.mjs` run, real DDL |
| Runtime-role **creation** (the `CREATE ROLE ...` statement executing without error) | **Yes** — the statement ran and returned no error |
| Runtime-role **effective privilege enforcement** (actually connecting AS that role and confirming its real, PostgreSQL-recorded attributes/privileges) | **No — this was never exercised.** The original report disclosed this exact limitation in its own "Test role" section ("this run created the role but never connected as it or exercised its privileges against real queries") — that disclosure was accurate and is preserved here, not walked back. |
| Outbound transport guard | **No — never exercised.** The guard installs only inside `vitest.postgres.setup.ts`, which the validation-only run never invokes. The original report disclosed this too. |
| A harmless, real database write-and-rollback | **No — this specific Gate B requirement (from the governing Stage 2 order's own Phase B §B4, "a harmless test row against the approved disposable database") was never performed in the original run.** This is the one genuine, previously-unfilled gap this document exists to close. |

**No prior successful result is recharacterized as a failure.** Container identity, in-database identity, marker verification, and migration application remain exactly as reported: real, successful, PostgreSQL-verified. What is corrected is the classification of runtime-role *enforcement* and the outbound guard from implicitly-assumed-covered to explicitly *offline-tested-and-SQL-inspected-but-not-yet-runtime-verified* — and the addition of the one missing harmless-operation requirement, now implemented (Section B) but likewise not yet executed.

No prior command output is rewritten. No result is manufactured from the now-deleted container (`pay2pay-pgtest-10604-0b5a466b` from the original Phase B run, or `pay2pay-pgtest-24592-3d4e3c98` from the subsequent Phase C run) — both are gone, and nothing in this document claims otherwise or attributes any new evidence to either of them.

## B. Implementation — focused runtime-role verification (ORDER 02)

**File changed:** `scripts/postgres-test-db.mjs` only (plus its own offline test file, Section D).

**New functions**, each connecting as (or verifying facts about) the **actual runtime role**, never the bootstrap connection:

- `verifyRuntimeRoleIdentity({ sql })` — issues `SELECT current_user AS "user"` over a connection opened with the runtime role's own generated credentials (`buildRuntimeDatabaseUrl`), and requires the result to equal `pay2pay_test_runtime` exactly. This is the literal "not the bootstrap connection masquerading as the runtime role" proof — a distinct connection, distinct credentials, distinct verification.
- `verifyRuntimeRoleAttributes({ sql })` — queries PostgreSQL's own `pg_roles` catalog (`rolsuper`, `rolcreatedb`, `rolcreaterole`, `rolreplication`, `rolbypassrls`) and requires every superuser-adjacent flag false and `rolbypassrls` true — confirming what PostgreSQL itself recorded, not merely re-reading the `CREATE ROLE` statement text this same file issued.
- `verifyMarkerTableIsReadOnlyForRuntimeRole({ sql })` — queries `has_table_privilege(...)` for `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` against `_pg_test_harness_marker`, plus its owner via `pg_class`/`pg_get_userbyid`, and requires: `SELECT` present, all four write-capable privileges absent, and the owner is never the runtime role.
- `verifyApplicationTablePrivileges({ sql, tableName })` — the same `has_table_privilege` pattern for `SELECT`/`INSERT`/`UPDATE`/`DELETE`, applied to `APPLICATION_TABLES_TO_VERIFY = ["agreement", "payment_attempt", "payment_retry"]` — a representative sample directly relevant to REM-008, not an exhaustive schema-wide audit.

**Fail-closed behavior:** each function returns `{ ok: false, reason }` on any mismatch (never throws itself); `main()` wraps every call in `if (!x.ok) throw new HarnessFailure(...)`, inside the exact same outer `try` block every pre-existing identity check already uses. There is no code path anywhere in this file that falls back to the bootstrap connection for test execution if any of these checks fails — a failure here aborts before `resolveRunMode`/Vitest is ever reached, and the existing, unconditional `finally`/`cleanupAndFinalize()` still runs.

## C. Implementation — harmless database-operation evidence (ORDER 03)

**Table chosen:** a **new, narrowly-scoped, infrastructure-only fixture** — `_pg_test_harness_scratch` (`id uuid primary key default gen_random_uuid(), note text not null, created_at timestamptz not null default now()`) — rather than reusing any real application table. This avoids entirely the concern this order raises (no payment execution, no provider submission, no customer/bank/email/SMS data of any kind, real or synthetic-but-shaped-like-production) by construction: the table holds nothing but a single free-text `note` column, and no application code anywhere references it.

**Exact operations** (`performHarmlessScratchOperation`, executed as the runtime role):
```sql
BEGIN;
INSERT INTO _pg_test_harness_scratch (note) VALUES ($1) RETURNING id, note;   -- $1 = a fresh, random, test-only synthetic string
SELECT id FROM _pg_test_harness_scratch WHERE note = $1;                      -- observed INSIDE the transaction — must return exactly 1 row
ROLLBACK;                                                                      -- unconditional
SELECT id FROM _pg_test_harness_scratch WHERE note = $1;                      -- observed AFTER rollback — must return exactly 0 rows
```
The table itself is created under the bootstrap role (the runtime role has no schema `CREATE` right, by design — Section D of the prior correction report) and granted only `SELECT, INSERT` — never `UPDATE`/`DELETE`/`TRUNCATE`/ownership. The ownership marker is never touched by this operation. No isolation check is bypassed — this entire sequence runs only after every check in Section B has already passed.

**Where it runs:** unconditionally, in `main()`, immediately after the Section B verification and strictly before the `resolveRunMode` branch — so it executes in the **default, validation-only invocation**, exactly as this order requires ("`--run-tests` remains unnecessary for this requirement"). A failed verification (an insert that doesn't read back correctly, or — the actual "not harmless" check — a row that persists after `ROLLBACK`) throws `HarnessFailure`, aborting before any further step and still triggering the existing unconditional cleanup.

## D. Offline tests and verification commands

25 new offline tests were added to `scripts/postgres-test-db.test.mjs` (all dependency-injected, zero real Docker/Postgres contact): `verifyRuntimeRoleIdentity` (accepts genuine match; rejects a different role — the exact masquerading case; rejects an empty result), `verifyRuntimeRoleAttributes` (accepts the intended set; rejects each of `SUPERUSER`/`CREATEDB`/`CREATEROLE`/`REPLICATION` individually; rejects a missing `BYPASSRLS`; rejects a missing `pg_roles` row), `verifyMarkerTableIsReadOnlyForRuntimeRole` (accepts read-only; rejects each of excessive `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` individually; rejects runtime-role ownership; rejects a missing `SELECT`), `verifyApplicationTablePrivileges` (accepts full DML; rejects a missing privilege), `buildScratchTableStatements` (confirms the table is created and only `SELECT, INSERT` granted, never a write-capable or ownership statement), and `performHarmlessScratchOperation` (succeeds through the full BEGIN/INSERT/SELECT/ROLLBACK/SELECT sequence; fails when the insert can't be read back; fails when a row unexpectedly persists after rollback — proving the "not actually harmless" case is caught; confirms `ROLLBACK` is issued even when the mid-transaction check itself fails).

**ORDER 03's "confirm a failed verification aborts the harness and still invokes exact-container cleanup" is satisfied structurally, not by a new end-to-end test**, and this is stated plainly rather than silently assumed: every new verification function returns `{ ok: false, reason }` on failure; `main()` (re-read in full after this change — Section E) wraps every one in `if (!x.ok) throw new HarnessFailure(...)`, inside the identical outer `try`/`catch`/`finally` structure the 18 pre-existing `finalizeHarnessRun`/`removeThisRunContainer`/`computeFinalExitCode` offline tests already exhaustively cover for every cleanup success/failure/spawn-error combination. No new throw site changes that mechanism's shape, so re-proving it end-to-end for these specific new failure reasons would only duplicate existing coverage, not add new assurance.

| Command | Result |
|---|---|
| `npm run test:tooling` | **170/170 pass**, exit 0 (145 pre-existing + 25 new) |
| `npm run typecheck` | **0 errors**, exit 0 |
| `npm run lint` | **0 errors**, exit 0, 12 pre-existing warnings (unchanged set) |
| `npx vitest run` (full non-PostgreSQL suite) | **257/257 files, 2237/2237 tests pass**, exit 0 |

No database-dependent command was executed. No failing offline test occurred during this round's own development — all new tests passed on completion (no failure was hidden or silently corrected without disclosure).

## E. Execution boundary re-verification (ORDER 04)

`main()` was re-read in full, end to end, after implementing Sections B and C. Confirmed exact order (line numbers as of this file's current state):

```
docker run → discover port → validateResolvedTarget (static)
  → docker inspect → verifyContainerIdentity                         [line ~657 — before first connection]
  → waitForReady (first real connection)                             [line ~670]
  → verifyDatabaseIdentity (current_database/current_user)            [line ~673 — before first write]
  → writeOwnershipMarker → verifyHarnessOwnership (immediate)         [line ~689 — before migrations]
  → apply-migrations-fresh.mjs                                        [line ~694]
  → buildRuntimeRoleStatements (role creation)                        [line ~707]
  → buildScratchTableStatements (scratch table creation)              [line ~717]
  → NEW: verifyRuntimeRoleIdentity / Attributes / Marker / Tables     [line ~733 — only after role+migrations succeed]
  → NEW: performHarmlessScratchOperation                              [same block]
  → resolveRunMode(argv): "validate-only" (default) → STOP            [line ~766]
                            "--run-tests" (explicit) → run test suite  [line ~778]
  → finally: cleanupAndFinalize() — unconditional, every exit path    [line ~795]
```

Container inspection precedes the first connection; in-database identity precedes the first write; the marker is bootstrapped and verified before migrations; the new runtime-role verification and harmless operation occur only after migrations and role creation succeed, and run in **both** modes (never gated behind `--run-tests`); the default invocation still cannot reach the Vitest-invoking branch; `--run-tests` remains the one explicit, separate path, and — unchanged from every prior round — always establishes its own new container name, run token, and port (nothing persists across invocations). Every failure, old or new, still funnels through the same `HarnessFailure` → outer `catch` → nonzero exit → unconditional `finally` cleanup targeting only the exact container this run generated.

## F. Whether the existing command is sufficient

**Yes.** `node scripts/postgres-test-db.mjs` (no arguments — the existing, unchanged validation-only entry point) is sufficient after these changes; **no new command, flag, or script is introduced.** The new runtime-role verification and harmless-operation steps are unconditional additions to the same execution path this command has always taken — a supplemental run uses the identical invocation, producing a **new** disposable container (its own fresh identity, run token, and port, per Section E) rather than reusing anything from either prior run.

## G. Exact disposable-target specification for the proposed supplemental run

| Field | Value |
|---|---|
| Image | `postgres:17-alpine` (already cached locally as of the last check) |
| Docker context | `desktop-linux` (local npipe — confirmed non-remote in both prior rounds) |
| Bind | `127.0.0.1:<Docker-assigned ephemeral port>` |
| Container identity | Freshly generated `pay2pay-pgtest-<pid>-<random>`, its own run token |
| Database | `postgres` |
| Bootstrap role (migrations, role/table creation) | `postgres` |
| Runtime role (now to be verified in-place, not merely created) | `pay2pay_test_runtime` — `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`, the one owner-accepted `BYPASSRLS` exception |
| Ownership marker | `_pg_test_harness_marker` — bootstrap-owned, runtime role read-only |
| New scratch fixture | `_pg_test_harness_scratch` — bootstrap-owned, runtime role `SELECT, INSERT` only, verified empty after every use |

## H. Owner authorization statement (exactly one supplemental validation-only execution)

> I authorize exactly one supplemental validation-only execution of `node scripts/postgres-test-db.mjs` (no `--run-tests`), against a newly generated disposable container using the same local Docker Desktop context and `postgres:17-alpine` image as the prior runs. This run may verify container and in-database identity, bootstrap and verify the ownership marker, apply the unchanged migrations, create the runtime role and the new `_pg_test_harness_scratch` fixture, then — the new capability — connect AS the runtime role itself to verify its actual effective identity, `pg_roles` attributes (including the accepted `BYPASSRLS` exception), ownership-marker read-only protection, and representative application-table privileges, and perform one harmless insert-observe-rollback-confirm operation against the scratch fixture only. It must remove its own container when finished and produce a separate execution addendum documenting the actual results, including any failure, before any further phase is considered. I do not authorize `--run-tests`, Phase C, any other database, any real provider, or any production/migration edit.

**No approval has been granted by delivering this document.** The proposed database command in Section H was not executed under this order.

*End of report.*
