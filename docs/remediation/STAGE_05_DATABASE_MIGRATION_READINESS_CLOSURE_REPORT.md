# PAID2YOU — Stage 5: Database and Migration Readiness — Authoritative Final Closure Report (V2)

This report responds to the "STAGE 5 — FINAL SOURCE-FREEZE HARNESS CORRECTION + AUTHORITATIVE
CAMPAIGN RE-RUN — NO-RETURN-UNTIL-CODEX-READY" order. It supersedes the prior "Authoritative
Final Closure Report," whose acceptance basis
(`docs/remediation/stage5-evidence/authoritative-final/`) is **no longer authoritative**: that
round's source-freeze coverage was itself defective (see below) and cannot be relied upon to
prove "zero source drift" meant what it claimed. The sole acceptance basis for Stage 5 is now
`docs/remediation/stage5-evidence/authoritative-final-v2/`. Prior evidence directories
(`authoritative-final/` and the two earlier remediation rounds before it) remain on disk,
untouched, referenced only as historical/superseded context.

## Why `authoritative-final/` is superseded (not hidden)

Its source-freeze collector (`listAllChangedFiles()` in the pre-correction version of
`scripts/stage5-authoritative-campaign.mjs`) parsed `git status --porcelain=v1` as a
human-readable text blob: it called `.trim()` on the ENTIRE multi-line status output before
slicing each individual line's fixed 3-character status prefix (`XY `). Whenever that blob's very
FIRST line happened to begin with a leading space (an ordinary "unstaged, modified" entry —
exactly the shape ` M .github/workflows/ci.yml` takes), the blob-level `.trim()` silently ate that
one leading space, shifting the fixed-width parse for THAT SINGLE LINE by one character and
truncating its leading dot: `.github/workflows/ci.yml` became `github/workflows/ci.yml`, a path
that does not exist, silently absent from every hash and every downstream coverage claim. The
round's own `driftCount: 0` result was real for the paths it actually tracked, but did not prove
full changed-file coverage, because the collector itself had an undetected gap. That round's
closure report's DB/G5 claims are not asserted to be technically wrong — the underlying tests all
passed identically — but its coverage GUARANTEE was not what it claimed to be, so it cannot serve
as the acceptance basis. `authoritative-final-v2/` corrects this at the root and re-runs the
entire campaign.

## The corrected freeze mechanism (RULES 2–5)

`scripts/lib/freezeDiscovery.mjs` (new) replaces all porcelain/positional-string parsing with
Git's own NUL-delimited, machine-readable output exclusively:

- `git diff --name-only -z HEAD --` — tracked files changed relative to HEAD (staged + unstaged).
- `git ls-files --others --exclude-standard -z` — untracked, non-ignored files.
- The two path sets are unioned; every path is classified individually
  (`{path, exists, sha256, size}` if present, `{path, exists:false, state:"deleted"}` if not) —
  never skipped, never re-parsed from a second, potentially-lossy representation.

A harness self-test, `scripts/stage5-freeze-discovery.test.mjs` (7/7 pass, `node --test`),
proves — against synthetic data, never the real repository's own files — that a leading dot
survives (`.github/workflows/ci.yml`), embedded whitespace survives, a deleted changed path is
represented explicitly rather than dropped, and an untracked-only path is included via the union.

## Hard coverage invariant and freeze-integrity validation (RULES 6, 16)

`authoritative-final-v2/source-freeze.json` and `source-freeze-after.json` each assert, at
capture time, that the freeze-entry count equals the Git-changed-path count and that the two path
sets are identical — by construction (entries are built by mapping directly over the unioned
path array), checked explicitly anyway. `scripts/stage5-authoritative-v2-manifest-and-check.mjs`
independently re-verifies this (and duplicate-freeing, and that no `exists:false` entry lacks an
explicit `"deleted"` state, and that `.github/workflows/ci.yml`'s leading dot is intact) by
reading the already-written JSON files, not by trusting the campaign script's own claim:

```
CI WORKFLOW FREEZE COVERAGE: PASS
SOURCE FREEZE INTEGRITY VALIDATION: PASS
AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: PASS
```

## `.github/workflows/ci.yml` explicitly (RULE 7/15)

Present in both the before- and after-campaign changed-path sets
(`authoritative-final-v2/source-freeze.json` / `source-freeze-after.json`,
`ciWorkflowEntry.path === ".github/workflows/ci.yml"`), with a valid SHA-256 in both
(`16809df98f6a29b4ea31d732da89d6ff34683806badb87022767605280bb10a9`, identical before and after —
`authoritative-final-v2/source-freeze-drift.json` → `ciWorkflowDrift.count: 0`).

## The authoritative campaign (10 commands, RULE 12) — identical technical results to the superseded round, independently re-captured

Orchestrator: `scripts/stage5-authoritative-campaign.mjs` (freeze mechanism corrected; the 10
acceptance-critical commands themselves are unchanged). Every command captured as a four-file
evidence set (`.command.txt`/`.stdout.txt`/`.stderr.txt`/`.status.json`) under
`authoritative-final-v2/`.

| # | Command | Evidence | Exit | Key figures |
|---|---|---|---|---|
| 1 | `node scripts/postgres-test-db.mjs --stage5-only --run-tests` | `01-schema-parity-and-index-extraction.*` | 0 | `2 files / 15 tests`. Derived counts: `tables=74 columns=864 primaryKeys=74 foreignKeys=136 indexes=42 enums=76`. `[indexes] expected=42 missing=0 semanticMismatches=0 keySlotCompletenessFailures=0 totalActualIndexesChecked=129`. All required index lines printed, including `CODEX FALSE-POSITIVE REGRESSION: REJECTED AS EXPECTED`. |
| 2 | `npx vitest run src/db/schemaParityComparators.self-validation.test.ts` | `02-verifier-self-validation.*` | 0 | `1 file / 34 tests`. |
| 3 | `node scripts/stage5-forward-upgrade-test.mjs` | `03-forward-upgrade.*` | 0 | `FORWARD UPGRADE: PASS (cutoff=20260928000000_ledger_entry_type_stage4_parity.sql, migrations_before=57, migrations_after=1, seed preserved)`. |
| 4 | `node scripts/stage5-migration-runner-proof.mjs` | `04-migration-runner-proof.*` | 0 | All three phases PASS (applied-state persistence, pending-only, failure/retry). |
| 5 | `node scripts/postgres-test-db.mjs --stage4-only --run-tests` | `05-stage4-regression.*` | 0 | `7 files / 37 tests`. |
| 6 | `npx tsc --noEmit` | `06-typecheck.*` | 0 | Zero errors. |
| 7 | `npm run lint` | `07-lint.*` | 0 | `12 problems (0 errors, 12 warnings)`, all pre-existing. |
| 8 | `npm test` (run 1) | `08-broader-regression-run-1.*` | 0 | `261 files / 2289 tests`. |
| 9 | `npm test` (run 2) | `09-broader-regression-run-2.*` | 0 | `261 files / 2289 tests`. |
| 10 | `npm test` (run 3) | `10-broader-regression-run-3.*` | 0 | `261 files / 2289 tests`. |

## Post-campaign drift (RULES 13–14) — independently re-derived, not reused

`authoritative-final-v2/source-freeze-after.json` was produced by a SECOND, independent
invocation of the same NUL-delimited discovery (never a reuse of the before-freeze's own path
array — per RULE 14, comparing two snapshots from the same potentially-incomplete collector
would prove nothing; this collector's coverage was independently re-verified at BOTH snapshots).
`authoritative-final-v2/source-freeze-drift.json`:

```
CHANGED PATH SET DRIFT: 0
EXISTENCE STATE DRIFT: 0
CONTENT HASH DRIFT: 0
TOTAL SOURCE DRIFT: 0
```

(The campaign's own evidence-output directory,
`docs/remediation/stage5-evidence/` — where this run's own command evidence and the
migration-runner-proof script's internal sidecars are written — is excluded from drift accounting
for the same reason it was excluded in the superseded round: it changes by design as the campaign
documents itself, and counting that as "source drift" would make zero drift definitionally
unreachable. No other path, anywhere in the repository, is excluded.)

## Evidence manifest (RULE 17)

`authoritative-final-v2/manifest.json` / `manifest.md` enumerate: raw NUL-delimited git inventory
(before and after), the before/after freeze JSON, the drift JSON, all ten four-file command
evidence sets, the campaign summary, deployment-ordering evidence, provider-boundary evidence,
pre-push inventory, and the adversarial preflight. Result:

```
AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: PASS
```

## Codex-style adversarial preflight (RULE 18)

Full record: `authoritative-final-v2/adversarial-preflight.md`. Part 1 specifically attacks the
freeze logic itself (the 7 required questions: can a leading-dot path disappear, can whitespace
corrupt parsing, can a deletion be silently skipped, can an untracked file be omitted, can the
same incomplete collector produce a false zero-drift, is the changed-path set independently
re-derived both before and after, does every Git-reported path have a freeze entry) — all
answered in the freeze's favor, each citing a specific proof (the harness self-test, the raw
before/after captures, the mid-campaign independent re-verification). Part 2 carries forward the
six technical-mechanism analyses from the superseded round (unchanged in substance, since zero
product/test code changed this round). Result:

```
SOURCE-FREEZE FALSE-PASS RESISTANCE: PASS
```

## DB-01–DB-12 (every row cites a file inside `authoritative-final-v2/`)

| Invariant | Status | Evidence |
|---|---|---|
| DB-01 Migration completeness | PROVEN | `01-schema-parity-and-index-extraction.stdout.txt` |
| DB-02 Schema parity | PROVEN | `01-schema-parity-and-index-extraction.*` |
| DB-03 Fresh-build reproducibility | PROVEN | `01-schema-parity-and-index-extraction.stdout.txt` — `OK — all 58 migrations applied cleanly to an empty database.` |
| DB-04 Forward-upgrade reproducibility | PROVEN | `03-forward-upgrade.*` |
| DB-05 Data preservation | PROVEN | `03-forward-upgrade.*` |
| DB-06 Financial-invariant preservation | PROVEN | `05-stage4-regression.*` |
| DB-07 Constraint/index parity | PROVEN | `01-schema-parity-and-index-extraction.*` — `keySlotCompletenessFailures=0` across all 129 actual indexes |
| DB-08 RLS/security-schema parity | PROVEN | `01-schema-parity-and-index-extraction.*`, test 9 |
| DB-09 Migration runner correctness | PROVEN | `04-migration-runner-proof.*` |
| DB-10 Migration ordering safety | PROVEN | `04-migration-runner-proof.*` |
| DB-11 Historical migration immutability | PROVEN | `source-freeze-drift.json` (`TOTAL SOURCE DRIFT: 0`, migration file list unchanged) |
| DB-12 No manual production SQL dependency | PROVEN | Every command ran against disposable, throwaway Postgres only |

No BLOCKED. No PARTIAL.

## G5-01–G5-14 (Project Owner's exact definitions; every row cites a file inside `authoritative-final-v2/`)

| Gate | Definition | Status | Evidence |
|---|---|---|---|
| G5-01 | Migration-history integrity | PASS | `04-migration-runner-proof.*`; `source-freeze-drift.json` (migration list unchanged) |
| G5-02 | Schema parity | PASS | `01-schema-parity-and-index-extraction.*` |
| G5-03 | Fresh-build reproducibility | PASS | `01-schema-parity-and-index-extraction.stdout.txt` |
| G5-04 | Forward-upgrade reproducibility | PASS | `03-forward-upgrade.*` |
| G5-05 | Data preservation | PASS | `03-forward-upgrade.*` |
| G5-06 | Constraint parity | PASS | `01-schema-parity-and-index-extraction.*` |
| G5-07 | Enum/type parity | PASS | `01-schema-parity-and-index-extraction.*` |
| G5-08 | RLS/security-schema parity | PASS | `01-schema-parity-and-index-extraction.*`, test 9 |
| G5-09 | Stages 1–4 invariant preservation | PASS | `05-stage4-regression.*` |
| G5-10 | Deployment ordering defined | PASS | `authoritative-final-v2/deployment-ordering.md` establishes migration-first → dependent application deployment for the additive `payment_attempt_status` parity migration |
| G5-11 | Failure/retry procedure defined | PASS | `04-migration-runner-proof.*` Phase 3 |
| G5-12 | No manual production SQL dependency | PASS | Same as DB-12 |
| G5-13 | Evidence preservation | PASS | `manifest.json`/`manifest.md` — `AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: PASS`; nothing from any prior round deleted |
| G5-14 | Regression containment | PASS | `05-stage4-regression.*` + three independently-captured, byte-identical `08/09/10-broader-regression-run-*.*` passes (this V2 run's own, not reused from the superseded round) |

All PASS.

## Provider boundary (RULE 22)

`authoritative-final-v2/provider-boundary-check.txt`: zero Adyen references across every file
this Stage's remediation touched, including this round's own freeze-mechanism files
(`scripts/lib/freezeDiscovery.mjs`, `scripts/stage5-freeze-discovery.test.mjs`,
`scripts/stage5-authoritative-campaign.mjs`, `scripts/stage5-authoritative-v2-manifest-and-check.mjs`).
`package.json`'s only diff (two pre-existing, protective npm-script aliases) predates this entire
engagement, unchanged.

```
NEW UNWANTED BANKING/PROVIDER DEPENDENCIES INTRODUCED: 0
```

## Final contradiction audit (RULE 23)

- Report claims `15/34/37/2289×3` tests → all confirmed directly in each of the ten
  `authoritative-final-v2/*.stdout.txt` files.
- Report claims all 10 top-level commands exited 0 → `manifest.json`'s integrity check
  (`integrityPass: true`) independently asserts this from each `.status.json`'s own `exitCode`.
- Report claims zero source drift, fully covering the changed-file set → `source-freeze-drift.json`
  → `totalSourceDrift: 0`, AND `source-freeze.json`/`source-freeze-after.json` both independently
  pass the coverage invariant (entry count == changed-path count, set equality) — not merely
  "two files agree," but each individually proven complete.
- `.github/workflows/ci.yml` coverage is explicitly correct before and after, with matching
  hashes.
- No DB/G5 row cites `authoritative-final/` (the superseded directory) as its acceptance basis —
  every citation resolves to `authoritative-final-v2/`.
- G5-01 through G5-14 use exactly the Project Owner's 14 definitions, verbatim.

```
MATERIAL CONTRADICTIONS: 0
```

## Pre-push inventory (RULE 24)

`authoritative-final-v2/pre-push-inventory-git-status.txt`. `HEAD` =
`93bbbbf8950010d4c0a70c7133339dc352ebd0fd` (unchanged since before Stage 1).

- **New this round:** `scripts/lib/freezeDiscovery.mjs`, `scripts/stage5-freeze-discovery.test.mjs`,
  `scripts/stage5-authoritative-v2-manifest-and-check.mjs`,
  `docs/remediation/stage5-evidence/authoritative-final-v2/**`.
- **Modified this round:** `scripts/stage5-authoritative-campaign.mjs` (freeze mechanism
  rewritten; evidence output redirected to `authoritative-final-v2/`).
- **Untouched Stage 5 files from prior rounds:** every curated Stage 5 file (schema-parity test,
  comparators, index-extraction test, migration-runner-proof, forward-upgrade test, the Stage 5
  migration) — confirmed byte-identical via `source-freeze-drift.json`'s `curatedDrift: []`.
- **Stage 4 files:** untouched, confirmed via the same curated-drift check.
- **Migration files:** 58, unchanged list, confirmed via `migrationDrift: null`.
- **Evidence files:** all four rounds now on disk (`stage5-evidence/` top level,
  `authoritative-final/` superseded, `authoritative-final-v2/` current), nothing deleted.
- **Unrelated pre-existing files:** the large block of Stage 1–4 application/documentation files
  already present on this branch before this Stage began — out of scope, confirmed unchanged.

```
COMMIT/PUSH: NOT YET PERFORMED
```

## Final status

```
STAGE 5 AUTHORITATIVE FINAL CAMPAIGN V2: COMPLETE
FULL CHANGED-FILE FREEZE COVERAGE: VERIFIED
CI WORKFLOW FREEZE COVERAGE: VERIFIED
UNFROZEN CHANGED PATHS: 0
SILENTLY SKIPPED PATHS: 0
SOURCE FREEZE INTEGRITY VALIDATION: PASS
SOURCE-FREEZE FALSE-PASS RESISTANCE: PASS
SOURCE FILE DRIFT DURING CAMPAIGN: 0
SCHEMA PARITY: VERIFIED
INDEX EXPRESSION EXTRACTION: VERIFIED
VERIFIER SELF-VALIDATION: PASS
FRESH DATABASE BUILD: PASS
FORWARD UPGRADE: PASS
AUTHORITATIVE SUPABASE MIGRATION RUNNER: PASS
PENDING-ONLY MIGRATION APPLICATION: PASS
MIGRATION FAILURE/RETRY: PASS
STAGE 4 REGRESSION: PASS
TYPECHECK: PASS
LINT: PASS
BROADER REGRESSION RUN 1: PASS
BROADER REGRESSION RUN 2: PASS
BROADER REGRESSION RUN 3: PASS
DB-01 THROUGH DB-12: PROVEN
G5-01 THROUGH G5-14: PASS
MATERIAL STAGE 5 DEFECTS: 0
MATERIAL CONTRADICTIONS: 0
NEW UNWANTED BANKING/PROVIDER DEPENDENCIES INTRODUCED: 0
HISTORICAL MIGRATIONS MODIFIED: 0
STAGE 5 READY FOR FINAL CODEX ACCEPTANCE
COMMIT/PUSH: NOT YET PERFORMED
STAGE 6: NOT AUTHORIZED
```
