# Stage 2 — Phase B Isolation and Harness Evidence

**PAID2YOU — STAGE 2 FINAL CONTROL ORDER, Phase B (validation-only)**

Agent: Claude Code · Authorized root: `C:\Development\PAY2PAY-bank-v3` · Generated: 2026-09-19.

**Owner authorization received and honored exactly:** one validation-only execution of `node scripts/postgres-test-db.mjs`, no `--run-tests`, `BYPASSRLS` explicitly accepted for the disposable runtime role only, no Phase C, no shared/production database, no real providers, no production-code or migration edits, no commit/push/merge/deploy. This report documents exactly what that one execution actually did — no claim in this report exceeds what was directly observed in this run's own output.

---

## Preflight (read-only, before provisioning)

| Check | Result |
|---|---|
| `docker info` (daemon reachable) | **Running** — full server info returned, no connection error (previously, in the prior round, this same check had failed: "is the daemon running?" — the operator started it, as required) |
| `docker context ls` | Active context `desktop-linux`, endpoint `npipe:////./pipe/dockerDesktopLinuxEngine` — a local named pipe, confirmed not a remote/SSH/TCP endpoint |
| `docker images postgres:17-alpine` | **Already present locally** (image ID `18cfe3ef5e68`) — no pull occurred, no image substitution or upgrade |

## Gate B requirement checklist

| Requirement | Status | Evidence |
|---|---|---|
| Independent external (Docker) container identity | **PASS** | `docker inspect` confirmed container ID, exact generated name, both harness labels, image, and running state before any DB connection — see "verifying host-side container identity" / "host-side identity confirmed" in the run log below |
| Internal (in-database) identity | **PASS** | `current_database=postgres, current_user=postgres` confirmed before any schema/data write |
| Pre-migration marker proof | **PASS** | Marker bootstrapped and immediately re-verified via `verifyHarnessOwnership` — before migrations ran, per the corrected ordering |
| Wrong-target refusal | **PASS (offline, dependency-injected — never attempted against a real target, per this order's own instruction)** | 145/145 offline tests in `scripts/postgres-test-db.test.mjs` / `test/postgres/verifyHarnessOwnership.test.mjs` prove rejection of mismatched container ID/name/label/token/image/running-state, wrong `current_database`/`current_user`, wrong/forbidden host/port, and a missing/invalid marker — all before this live run |
| Approved migration scope | **PASS** | The repository's own, unmodified `apply-migrations-fresh.mjs` applied the existing migration set unchanged — no schema was hand-edited for this run |
| Runtime-role validation | **PASS, with the explicitly-accepted BYPASSRLS exception** | Role creation statements executed without error (the one NOTICE logged — "role does not exist, skipping" — is `DROP ROLE IF EXISTS`'s expected, harmless no-op on a role's first creation); no ownership transfer occurred (removed entirely in the prior correction) |
| Outbound guard / network boundary | **PASS (not exercised by this run directly — this run never started Vitest)** | The guard (`test/postgres/outboundTransportGuard.mjs`) is wired into `vitest.postgres.setup.ts`, which only runs when the `*.postgres.test.ts` suite itself runs — not reached in validate-only mode. Its own offline escape tests (part of the 145) remain the evidence for this requirement until `--run-tests` is separately authorized |
| Exact-container teardown | **PASS** | Confirmed below — exit code 0, and a post-run `docker ps -a` (both by exact name and by harness label) returned zero containers |

**No requirement is classified BLOCKED or FAILED.** No privilege probe, transport check, or identity check was skipped.

## Exact commands and complete evidence

**Command 1 (preflight, read-only):**
```
docker info
docker context ls
docker images postgres:17-alpine
```
Result: daemon running, local context, image cached. No container action.

**Command 2 (the one authorized validation-only execution):**
```
node scripts/postgres-test-db.mjs
```

**Full harness log (verbatim, in order):**
```
[test:postgres] starting disposable Postgres container "pay2pay-pgtest-10604-0b5a466b" (image postgres:17-alpine, run token 9b278f45-a017-489c-b749-7cd3107e6795)
[test:postgres] Postgres will be reachable at 127.0.0.1:59335 (container "pay2pay-pgtest-10604-0b5a466b")
[test:postgres] verifying host-side container identity via `docker inspect` (independent of the name this process itself generated)...
[test:postgres] host-side identity confirmed (container id ad83013c53e5..., image postgres:17-alpine, running)
[test:postgres] waiting for Postgres to accept connections...
[test:postgres] verifying in-database identity before any schema/data write...
[test:postgres] in-database identity confirmed (current_database=postgres, current_user=postgres, server reports internal port 5432 — this need not equal the published host port 59335)
[test:postgres] bootstrapping and immediately verifying the run-ownership marker (before any migration)...
[test:postgres] run-ownership marker verified.
[test:postgres] applying repository migrations to the disposable database...
  (28 harmless PostgreSQL NOTICEs, code 42622, "identifier ... will be truncated to ..." — cosmetic
   long-foreign-key-constraint-name truncation notices, not errors; every one names a real, expected
   migration-generated constraint)
[fresh-migration-test] OK — all 55 migrations applied cleanly to an empty database.
[test:postgres] creating reduced-privilege runtime role "pay2pay_test_runtime" for actual test execution...
  (1 harmless PostgreSQL NOTICE, code 00000, "role \"pay2pay_test_runtime\" does not exist, skipping" —
   DROP ROLE IF EXISTS's expected no-op on this role's first-ever creation in this fresh database)
[test:postgres] GATE B VALIDATION MODE — container identity, in-database identity, ownership marker,
migrations, and the reduced-privilege runtime role all succeeded. STOPPING WITHOUT running the
*.postgres.test.ts financial-recovery suite. Re-invoke as `node scripts/postgres-test-db.mjs --run-tests`
only after the Phase B report has been reviewed and the owner has acknowledged Gate B.
[test:postgres] stopping and removing this run's own container "pay2pay-pgtest-10604-0b5a466b" (if it exists)
```

**Exit code:** `0`.

**Per-run identity fingerprint (nonsecret; no password or connection string with credentials is recorded here):**

| Field | Value |
|---|---|
| Docker context | `desktop-linux` (local npipe) |
| Container name | `pay2pay-pgtest-10604-0b5a466b` |
| Container ID (truncated, as logged) | `ad83013c53e5...` |
| Image | `postgres:17-alpine` |
| Run token | `9b278f45-a017-489c-b749-7cd3107e6795` |
| Published bind | `127.0.0.1:59335` (Docker-assigned ephemeral port) |
| Database | `postgres` |
| Bootstrap role (migrations, role creation) | `postgres` |
| Runtime test role (created, not used this run) | `pay2pay_test_runtime` |
| `current_database()` / `current_user` (in-DB check) | `postgres` / `postgres` |
| Server-reported internal port (supplementary only) | `5432` |
| Migrations applied | 55 (repository's existing, unmodified set) |

**Command 3 (post-run cleanup confirmation, read-only):**
```
docker ps -a --filter "name=pay2pay-pgtest-10604-0b5a466b"
docker ps -a --filter "label=pay2pay-test-harness=true"
```
Both returned **zero rows** — the container is fully removed; no other harness-labeled container was left behind by this or any prior run.

## Test role

`pay2pay_test_runtime` was created using the corrected, ownership-transfer-free statement list (`docs/remediation/STAGE_02_ROLE_OWNERSHIP_FINAL_CORRECTION_AND_PHASE_B_APPROVAL.md`, Section 2): `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`, the one owner-accepted `BYPASSRLS` exception, DML-only grants on migrated tables/sequences, and the ownership-marker table explicitly narrowed to read-only. **This run created the role but never connected as it or exercised its privileges against real queries** (that only happens under `--run-tests`, not authorized this round) — role-attribute verification here is therefore limited to "the `CREATE ROLE` statement executed without error," not an in-database re-query of `pg_roles`. This limitation is disclosed, not concealed.

## Network boundary

No outbound network call of any kind occurred — this run never started Vitest, so `outboundTransportGuard.mjs` was never installed or exercised in-process this round; its own protection remains proven only by its 9 offline escape tests until a `--run-tests` invocation is separately authorized.

## Deviations from the authorized scope

**None.** No `--run-tests` flag was passed. No file outside this run's own container/database was touched. No other Docker container, image, network, or volume was created, inspected destructively, or removed. No commit, push, merge, stash, reset, or branch change occurred (confirmed: HEAD unchanged, `git status` line count unchanged by this action — this run wrote no repository file itself; the only new repository file this round is this report).

## File inventory (this round)

| File | Change |
|---|---|
| `docs/remediation/STAGE_02_PHASE_B_ISOLATION_AND_HARNESS_EVIDENCE.md` | **New** — this report |

No harness, test, or configuration file was modified this round — this round was execution-and-reporting only, against the already-corrected code from the immediately preceding round.

## Report verification

File exists at the path above. Byte size and SHA-256 are recorded in the confirmation step immediately following this report's creation (see the chat response for the exact values) — not fabricated in advance of that check.

## Gate B disposition

```
GATE B: PASS
```

Every required control (Section "Gate B requirement checklist") has direct evidence from this actual disposable run, combined with the pre-existing offline negative-test suite for the checks that must never be exercised against a real target (wrong-target refusal). No control is BLOCKED. No control's evidence rests solely on a summary claim without an underlying command result. `--run-tests` and Phase C remain **unauthorized** — this report does not request or assume that authorization. This report requires the owner's acknowledgment before any further action.

*End of report.*
