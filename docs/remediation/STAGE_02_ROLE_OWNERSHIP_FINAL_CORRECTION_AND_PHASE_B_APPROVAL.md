# Stage 2 — Role-Ownership Final Correction and Phase B Approval Evidence

**PAID2YOU — STAGE 2 FINAL ROLE-OWNERSHIP CORRECTION**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Mode: targeted offline correction only.
No Docker container startup, PostgreSQL connection, migration, schema change, role creation, test-data write, or database deletion occurred. Generated: 2026-09-19.

---

## 1. The original ownership defect

**Exact statement identified:** `buildRuntimeRoleStatements` (`scripts/postgres-test-db.mjs`) previously included `REASSIGN OWNED BY postgres TO pay2pay_test_runtime`, issued via the bootstrap connection immediately after migrations completed.

**Confirmed result (on PostgreSQL's own documented `REASSIGN OWNED` semantics — no live database connection is authorized, so this is not an observed live result, and is not claimed as one):** `REASSIGN OWNED BY <role>` reassigns ownership of **every** object the source role owns in the **current database**, with no per-object scoping mechanism. This would have included:
- The **ownership-marker table** (`_pg_test_harness_marker`), created by `writeOwnershipMarker` under the bootstrap role *before* this statement runs — the runtime role would have become its owner, able to `ALTER`/`DROP`/`TRUNCATE` it.
- **Potentially the database itself** — PostgreSQL's own documentation states `REASSIGN OWNED`, run as a superuser, additionally reassigns ownership of shared objects (databases, tablespaces) owned by the source role; the Docker `postgres:17-alpine` image's default `postgres` database is created owned by the bootstrap `postgres` role at container initialization.
- Every migrated application table/sequence — the one part of this that was actually intended.

**This statement has been removed entirely.** No replacement ownership-transfer statement of any kind was introduced — see Section 2.

## 2. Changed files, replacement design, and privileges

**Exact changed files:** `scripts/postgres-test-db.mjs` (`buildRuntimeRoleStatements`, plus a new exported `OWNERSHIP_MARKER_TABLE_NAME` constant), `scripts/postgres-test-db.test.mjs` (offline tests rewritten to match), `src/lib/payments/paymentWebhookRecovery.postgres.test.ts` (`TEST 008-H/I` amended — Section 6). No other file changed. No production source, schema, or historical migration was touched.

**Investigation performed before choosing the replacement (per ORDER 02's own instruction to inspect actual requirements first):** every one of the 8 `src/**/*.postgres.test.ts` files was grepped for `ALTER TABLE`, `DROP TABLE`, `CREATE TABLE`, `CREATE INDEX`, `CREATE TEMP(ORARY)`, `TRUNCATE`, `DROP INDEX`, `ALTER/CREATE SEQUENCE`, `CREATE/ALTER TYPE` — **zero matches anywhere**. The only raw SQL any test issues directly (`paymentWebhookRecovery.postgres.test.ts`) is `SET statement_timeout = 50` (a session parameter, never privilege-gated) and `SELECT pg_sleep(1)` (a built-in function; `EXECUTE` is granted to `PUBLIC` by default). **No existing test demonstrably requires DDL or object ownership.** The "real DDL/DML" language in `vitest.postgres.setup.ts`'s own doc comment describes the disposable database being DDL-*capable* — a property the migration step (run separately, under the bootstrap role, never the runtime role) actually exercises — not a property of the test bodies' own runtime operations, which are exclusively DML.

**Replacement statements, in order:**
```sql
DROP ROLE IF EXISTS pay2pay_test_runtime;
CREATE ROLE pay2pay_test_runtime LOGIN PASSWORD '<random>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO pay2pay_test_runtime;
GRANT USAGE ON SCHEMA public TO pay2pay_test_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pay2pay_test_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pay2pay_test_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pay2pay_test_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pay2pay_test_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON _pg_test_harness_marker FROM pay2pay_test_runtime;
```

**Ownership inventory:** no object's ownership is ever transferred, anywhere in this file. Every migrated table/sequence remains owned by the bootstrap `postgres` role. The runtime role receives only DML-level `GRANT`s on those objects — never `CREATE` on the schema (nothing in the actual test suite creates a new object) and never any owner-only right (`ALTER`, `DROP`, `TRUNCATE` structurally, `OWNER TO`).

**Ownership-marker protection:** the marker table is included in the blanket table grant (it lives in the same schema), so the last statement explicitly `REVOKE`s `INSERT, UPDATE, DELETE, TRUNCATE` on it from the runtime role — leaving only `SELECT`, the exact operation `verifyHarnessOwnership`'s own query performs. The runtime role can never create, replace, update, delete, truncate, drop, or own that table.

**RLS implication, assessed:** this schema's tables carry `.enableRLS()` (`payment_retry`, `notification_event`, etc.), paired — per earlier Stage 1 provider-isolation work — with a `REVOKE ALL ... FROM anon, authenticated` pattern. That design assumes a privileged service connection that RLS does not apply to at all (a table owner, or a superuser, is exempt from RLS by default), with RLS meant only to block a hypothetical direct low-privilege client — never the application's own backend queries. Every existing test has always run under the bootstrap role (owner + superuser), so **RLS has never actually been enforced against any of these 65+ tests**. Making the runtime role subject to RLS for the first time, with no live database available to confirm every policy actually permits every existing query, would be an untested, high-blast-radius behavior change this fix must not introduce. **`BYPASSRLS` is therefore included as one explicit, narrowly-bounded, disclosed exception** — presented here for owner review, not silently decided — scoped only to preserving already-proven test behavior; it grants no ownership, no superuser status, no database/role-creation rights, and no replication access. If the owner prefers to instead prove each RLS policy compatible with a non-bypassing role, that is a separate, larger undertaking requiring live-database iteration this order does not authorize.

## 3. Offline tests added/changed

`scripts/postgres-test-db.test.mjs` now asserts: the full statement list **never** contains `REASSIGN OWNED` or any `OWNER TO` text; the only schema-level grant is `USAGE` (no blanket schema `CREATE`); the marker table's own narrowing statement is present, matches `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON _pg_test_harness_marker FROM ...` exactly, and never mentions `SELECT` (which must remain granted, never revoked); the `CREATE ROLE` statement explicitly includes `BYPASSRLS` (not negated) alongside `NOSUPERUSER`/`NOCREATEDB`/`NOCREATEROLE`/`NOREPLICATION`; and the full statement list never grants `CREATEDB`/`CREATEROLE`/`REPLICATION`/`SUPERUSER` in non-negated form anywhere. The two now-obsolete tests that asserted `NOBYPASSRLS`/forbade `BYPASSRLS` (written under the prior, now-withdrawn design) were removed rather than left contradicting the corrected code.

## 4. Harness execution order, re-verified after this correction

Re-read `scripts/postgres-test-db.mjs`'s `main()` in full, end to end, after making this correction. Order is unchanged from the prior round's own fix (this correction only replaced the *content* of `buildRuntimeRoleStatements`, never its call site or position in `main()`):

```
docker run → discover host port → validateResolvedTarget (static)
  → docker inspect → verifyContainerIdentity            [FIRST identity gate — before any DB connection]
  → waitForReady (first real connection)
  → verifyDatabaseIdentity (current_database/current_user)   [before any schema/data write]
  → writeOwnershipMarker → verifyHarnessOwnership (immediate)  [before migrations]
  → apply-migrations-fresh.mjs
  → buildRuntimeRoleStatements (now ownership-transfer-free) executed via roleSql.unsafe(...)
  → resolveRunMode(argv): "validate-only" (default) → STOP, no Vitest invocation
                            "--run-tests" (explicit) → run *.postgres.test.ts under the runtime role
  → finally: cleanupAndFinalize() — unconditional, every exit path
```

The first database write remains the ownership-marker `INSERT`, and it is still preceded by every required identity check (container, then in-database) — unchanged by this correction. A failed `roleSql.unsafe(statement)` call (e.g. a malformed statement) throws inside `main()`'s existing `try` block, which is not separately caught — it propagates to the outer `catch`, sets a nonzero exit code, and still runs `cleanupAndFinalize()` in `finally`; there is no fallback path anywhere in this file that would run the test suite under the bootstrap role if runtime-role creation fails. `resolveRunMode` is unchanged: the default (no arguments) invocation still cannot reach the Vitest-invoking branch; `--run-tests` is still the one explicit, separate flag required. Every invocation still generates its own container name, run token, and port (via `generateContainerName`/`randomUUID`/Docker's own ephemeral-port assignment) and never reads or trusts another invocation's state — confirmed by inspection: no file in this repository persists a container name, run token, or port across invocations. The outbound-transport guard (`test/postgres/outboundTransportGuard.mjs`, wired into `vitest.postgres.setup.ts`) and the provider test doubles (`SandboxPaymentProvider`, `InMemoryEmailSender`/`InMemorySmsSender` via `createTestNotificationService`) are untouched by this round's edits — confirmed by `git status` showing no change to either file this round.

## 5. Offline test commands, exit statuses, and one confirmed regression during this correction

| Step | Command | Result |
|---|---|---|
| 1 (first attempt, before fixing two stale tests) | `npm run test:tooling` | **2 failures**: the two now-obsolete `NOBYPASSRLS`-asserting tests failed against the corrected, intentionally-`BYPASSRLS` code — exact assertion errors preserved below, not concealed |
| 2 (correction: removed the two obsolete tests, since they asserted the OLD, now-withdrawn design) | `npm run test:tooling` | **145/145 pass**, exit 0 |
| 3 | `npm run typecheck` | **0 errors**, exit 0 |
| 4 | `npm run lint` | **0 errors**, exit 0, 12 pre-existing warnings (unchanged set) |
| 5 | `npx vitest run` (full non-PostgreSQL suite) | **257/257 files, 2237/2237 tests pass**, exit 0 |

**Failure detail, not concealed:** step 1's two failures were `buildRuntimeRoleStatements never grants CREATEDB, CREATEROLE, REPLICATION, or BYPASSRLS anywhere in the full statement list` and the companion `NOBYPASSRLS`-asserting test — both written under the withdrawn ownership-transfer design, both correctly failing once `BYPASSRLS` became an intentional, disclosed part of the corrected design. They were removed (not weakened, not skipped) because they no longer described the intended behavior; the corrected design is now covered by the new tests in Section 3. `npm run test:postgres`, `docker version`/`docker info`, and any database connection were **NOT EXECUTED** this round.

## 6. REM-008 acceptance requirements — 008-H amendment and same-retry concurrency

**008-H amended, existing assertions preserved verbatim, added:** exact `status === "claimed"` (not merely the two pre-existing `not.toBe` checks); `executionToken` non-null after the first blocked firing, and identical (never reissued) after a second blocked firing; the durable Phase-A anchor row (`payment_attempt` matched by `idempotencyKey = 'retry-' + retryId`) confirmed to exist exactly once, in status `"submitted"`, with the same row identity across both firings; and — the previously entirely-missing proof — **genuine subsequent recoverability**: a fresh, authorized (`flag: true`) coordinator's real `resolveAmbiguousRetry` call against the SAME retry/idempotency key, using a real `SandboxPaymentProvider`, is asserted to reach `outcome: "fired"`. This reuses the identical `resolveAmbiguousRetry → resolveNotFoundOutcome` mechanism `TEST 008-F` already exercises (the anchor's provider was never actually contacted while blocked, so a real provider genuinely has no record yet) — no separate/simplified mechanism was introduced. 008-I's own, different ambiguous-claim/backoff-scheduling scenario was not substituted for any part of this — 008-H's amendment is entirely self-contained within its own existing test.

**Same-retry competing-worker race — traced and proven impossible by construction, no new test added:** `establishDurableDispatchIntent` (`failedPaymentRetryCoordinator.ts:1598`) is the sole entry point that transitions a `payment_retry` row from `"scheduled"` to `"claimed"`. It acquires a `FOR UPDATE` row lock on the owning `agreement` row first (`:1616`), then on the `installmentScheduleItem` row (`:1623-1628`), and holds both for the remainder of the transaction. The actual claim is a single conditional `UPDATE payment_retry SET status='claimed', execution_token=$token WHERE id=$retryId AND status='scheduled' RETURNING id` (`:1682-1686`); if zero rows are returned, the method returns `{ outcome: "not_claimable" }` (`:1687`). Two concurrent invocations targeting the **same** retry necessarily target the same installment/agreement, so the second transaction blocks on the shared row lock until the first commits; once it does, the row's status is already `"claimed"`, so the second transaction's own conditional `UPDATE` matches zero rows and it receives `"not_claimable"` — never a second dispatch. This is not merely inferred from a test name: the row-lock-then-conditional-update pattern is a standard, deterministic PostgreSQL compare-and-swap, and the general mechanism (a real transaction genuinely blocking a concurrent one on this exact lock, empirically, with two independent connections) is already proven by the existing, unmodified `R-B40-STRICT-B` test. Per this order's own accepted alternative ("If the race is impossible, prove its impossibility from the actual locking and state-transition code"), **no new test was added** for this specific scenario.

**All REM-008 PostgreSQL cases remain explicitly NOT EXECUTED / NOT VERIFIED**, including the newly amended 008-H and every case from the prior round (008-C, 008-F, 008-F-BLOCKED, 008-G, 008-I) — none has been run against a real database.

## 7. Remaining unresolved requirements

Every real-PostgreSQL requirement (008-C, 008-F, 008-F-BLOCKED, 008-G, 008-H, 008-I, and the same-retry mechanism proven only by static code analysis above) remains unexecuted. Docker Desktop's engine was confirmed, via read-only diagnostics in the immediately preceding round, not to be running (`docker info` → "failed to connect to the docker API ... is the daemon running?"); this was not re-checked this round, since this order's own scope is a targeted offline correction, not a new Docker diagnostic pass. Offline verification (this section and Section 5) is explicitly distinguished from Phase B/C evidence, which does not yet exist.

## 8. Proposed validation-only command and effects (unchanged in shape from the prior round; content updated to reflect this correction)

`node scripts/postgres-test-db.mjs` (no `--run-tests`) would, if separately authorized and if Docker Desktop's engine is running: create one disposable `pay2pay-pgtest-<pid>-<random>` container (`postgres:17-alpine`, loopback-only, Docker-assigned port) → verify its identity via `docker inspect` → connect once and verify `current_database`/`current_user` → bootstrap and immediately verify the ownership marker → apply the repository's unchanged migrations → create the `pay2pay_test_runtime` role using the corrected, ownership-transfer-free statement list above → **stop**, without ever invoking the `*.postgres.test.ts` suite → unconditionally remove its own container. Potential failure modes: Docker daemon not running (currently the case); image pull required if not cached locally; any identity-check mismatch; a malformed role statement (none anticipated, but would abort before any test execution per Section 4). No other command or effect is proposed.

## 9. Owner authorization statement (Phase B validation only — not `--run-tests`, not Phase C)

> I authorize exactly one validation-only execution of `node scripts/postgres-test-db.mjs`, using the local Docker Desktop `desktop-linux` context, the existing `postgres:17-alpine` disposable image, a freshly generated `pay2pay-pgtest-<pid>-<random>` container bound only to a loopback, Docker-assigned port, and the disposable `postgres` database. This run may verify container and database identity, bootstrap and verify the ownership marker, apply the repository's unchanged migrations, and create the `pay2pay_test_runtime` role using the corrected statement list in Section 2 of this report — including its one disclosed exception (`BYPASSRLS`, to preserve already-proven test behavior, granting no ownership and no superuser/database/role-creation/replication rights) — and must remove its own container when finished. I do not authorize `--run-tests`, any production/development/shared/hosted database, any real provider, any change to production source/schema/migrations, or any commit, merge, push, or deployment. The agent must stop after delivering the Phase B evidence report for my review, and this statement does not itself authorize Phase C.

**No approval has been granted by delivering this report.**

*End of report.*
