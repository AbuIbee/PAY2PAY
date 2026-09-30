# Stage 5 Evidence Manifest — Final Zero-False-Positive Index Parity Remediation (authoritative)

This is the THIRD manifest revision. It supersedes the "Zero-False-Positive Completion" manifest
(kept below as historical, Part A) in response to Codex's independently-demonstrated index
false-positive (an actual `UNIQUE(payment_attempt_id, lower(provider_name))` reducing to
`columns=["payment_attempt_id"]` and falsely matching an accepted
`UNIQUE(payment_attempt_id)`). That defect is fixed at its root (the PostgreSQL catalog
extraction itself), proven fixed via a real disposable-Postgres scratch-table validation and a
dedicated regression test, and re-verified in a new frozen final campaign (Part B).

## Part B — the NEW frozen final campaign (Section 13), current and authoritative

Master orchestrator: `scripts/stage5-final-campaign.mjs` (updated to an 8-step sequence matching
Section 13's 11 numbered items — see the script's own header comment for the exact mapping).
First run `startedAt` `2026-09-29T14:45:57.720Z`, `finishedAt` `2026-09-29T14:51:40.201Z`; step 8
(`npm test`) was corrected by one immediate, zero-code-change rerun after hitting unrelated
resource-contention test timeouts — see
`status/final-campaign-08-npm-test-first-attempt-flaky.md` for the full, transparent root-cause
investigation. Master result: `status/final-campaign-summary.json`
(`allPassed: true`, `evidenceIntegrityPass: true`).

| # | Order item(s) | Command | Sidecar | Exit | Key figures |
|---|---|---|---|---|---|
| 1 | 1, 2, 4 — fresh build + corrected schema-parity suite + real-PG index-extraction self-validation | `node scripts/postgres-test-db.mjs --stage5-only --run-tests` | `status/final-campaign-01-schema-parity-and-index-extraction.json` | 0 | `schemaParity.postgres.test.ts`: 10/10, derived counts `tables=74 columns=864 primaryKeys=74 foreignKeys=136 indexes=42 enums=76`, index test prints `INDEX EXTRACTION KEY-SLOT COMPLETENESS: PASS`, `EXPRESSION KEY PRESERVATION: PASS`, `INCLUDE COLUMN SEPARATION: PASS`, `INDEX/UNIQUE SEMANTIC PARITY: PASS` (`totalActualIndexesChecked=129`, `keySlotCompletenessFailures=0`). `indexExtraction.postgres.test.ts`: 5/5, prints `EXPRESSION KEY PRESERVATION: PASS`, `CODEX FALSE-POSITIVE REGRESSION: REJECTED AS EXPECTED`, `INCLUDE COLUMN SEPARATION: PASS`, `INDEX EXTRACTION KEY-SLOT COMPLETENESS: PASS`. Combined: 2 files / 15 tests. |
| 2 | 3 — comparator self-validation suite | `npx vitest run src/db/schemaParityComparators.self-validation.test.ts` | `status/final-campaign-02-verifier-self-validation.json` | 0 | 34/34 (up from 30 — 4 new tests: `INDEX-EXPRESSION-FALSE-POSITIVE-REGRESSION`, key-slot-completeness detection, expression-only-index non-zero-keys, INCLUDE-column-vs-key distinction). |
| 3 | 5 — forward-upgrade proof | `node scripts/stage5-forward-upgrade-test.mjs` | `status/final-campaign-03-forward-upgrade.json` | 0 | `FORWARD UPGRADE: PASS (cutoff=20260928000000_ledger_entry_type_stage4_parity.sql, migrations_before=57, migrations_after=1, seed preserved)`. |
| 4 | 6, 7 — Supabase applied-state/pending-only proof + failure/retry proof | `node scripts/stage5-migration-runner-proof.mjs` | `status/final-campaign-04-migration-runner-proof.json` + `status/stage5-migration-runner-proof-summary.json` + `status/db09-*.json`, `status/pending-only-*.json`, `status/failure-run.json`, `status/retry-*.json` | 0 | Unchanged mechanism/result from the prior campaign (this remediation round touched no migration-runner code) — 58 tracked/unchanged on rerun; 57 pre-applied untouched + 1 pending applied exactly once; failed scratch migration's DDL did not persist and was not tracked, retry applied it exactly once. |
| 5 | 8 — Stage 4 PostgreSQL regression (reused, unexpanded) | `node scripts/postgres-test-db.mjs --stage4-only --run-tests` | `status/final-campaign-05-stage4-regression.json` | 0 | 7 files / 37 tests. |
| 6 | 9 — typecheck | `npx tsc --noEmit` | `status/final-campaign-06-typecheck.json` | 0 | Zero errors. |
| 7 | 10 — lint | `npm run lint` | `status/final-campaign-07-lint.json` | 0 | 0 errors, 12 pre-existing warnings (unchanged, none in Stage-5-touched files). |
| 8 | 11 — broader regression | `npm test` | `status/final-campaign-08-npm-test.json` | 0 | 261 files / 2289 tests (up from 2285 — the 4 new self-validation tests). See `status/final-campaign-08-npm-test-first-attempt-flaky.md` for the corrected-on-rerun history. |

## Part B.1 — empirical basis for the corrected index extraction (predates the frozen campaign; code/design basis, not a test-run result)

`index-extraction-catalog-probe.txt` — the 5-case (ordinary / mixed column+expression / expression-only / INCLUDE / partial) empirical probe against a real disposable-Postgres scratch table that `src/db/schemaParityComparators.ts`'s `ActualIndex`/`IndexKey` model and both
`src/db/schemaParity.postgres.test.ts`'s and `src/db/indexExtraction.postgres.test.ts`'s catalog
queries are built from — including the exact root-cause identification (the prior
`INNER JOIN pg_attribute` on `unnest(indkey)` silently drops `attnum=0` / expression positions).

## Part B.2 — pre-push inventory (unchanged requirement, refreshed)

`final-campaign-2-git-status.txt` — `HEAD` still `93bbbbf8950010d4c0a70c7133339dc352ebd0fd`
(unchanged since before Stage 1). New files this remediation round:
`src/db/schemaParityComparators.ts` (index model rewrite), `src/db/indexExtraction.postgres.test.ts`
(new), `scripts/lib/statusSidecar.mjs` (unchanged, carried over). Modified:
`src/db/schemaParity.postgres.test.ts` (test 8 rewritten), `src/db/schemaParityComparators.self-validation.test.ts`
(new index-model tests added), `scripts/postgres-test-db.mjs` (added
`src/db/indexExtraction.postgres.test.ts` to `STAGE5_POSTGRES_TEST_FILES`; added
`POSTGRES_TEST_BOOTSTRAP_DATABASE_URL` to the vitest child env, exposing the harness's pre-existing
bootstrap connection string — never weakening the reduced-privilege runtime role's own grants —
solely so `indexExtraction.postgres.test.ts` can create/drop its own test-owned scratch table),
`scripts/stage5-forward-upgrade-test.mjs` (doc-comment wording only, "byte-identical" →
"recorded persisted field values are unchanged"), `scripts/stage5-final-campaign.mjs`
(re-sequenced to Section 13's 8-step mapping).

## Part B.3 — provider boundary (refreshed)

`provider-boundary-check.txt` (original) plus a repeat grep across every file touched in this
remediation round (zero matches; `package.json` diff unchanged from before — still the same two
pre-existing protective npm-script lines).

```
NEW UNWANTED BANKING/PROVIDER DEPENDENCIES INTRODUCED: 0
```

## Part A — prior "Zero-False-Positive Completion" evidence (HISTORICAL — index-related claims in this part are superseded by Part B; everything else in it remains valid and untouched by this round)

Everything under `docs/remediation/stage5-evidence/status/final-campaign-0{1..8}-*` with
`timestamp` inside the window `[2026-09-29T13:26:53.362Z, 2026-09-29T13:28:48.289Z]`, plus
`final-campaign-full-output.txt`, `final-git-status.txt`, `index-predicate-normalization-probe.txt`,
`forward-upgrade-command.txt`/`-output.txt`, `fresh-build-schema-parity-command.txt`/`-output.txt`,
and the pre-Zero-False-Positive-Order files from the very first Stage 5 closure round
(`final-stage5-postgres-output.txt`, `final-typecheck-output.txt`, `final-lint-output.txt`,
`final-npm-test-output.txt`, `final-stage4-regression-output.txt`) — kept for continuity, cited
nowhere in the current DB-01–DB-12 / G5-01–G5-14 matrices.
