# Stage 5 — Codex-style adversarial preflight (RULE 17)

Organized by verification mechanism rather than repeated 26 times per DB/G5 item — each
mechanism backs several DB/G5 rows; the mapping is stated under each mechanism. All evidence
citations are to `docs/remediation/stage5-evidence/authoritative-final/`. Every "A–H" answer
below was checked against the actual raw file, not asserted from memory.

## Mechanism 1 — schema-parity + real-PostgreSQL index-extraction (`01-schema-parity-and-index-extraction.*`)

Backs: DB-01, DB-02, DB-03, DB-07, DB-08; G5-02, G5-03, G5-06, G5-07, G5-08.

- **A. Empty expected set?** No. The suite's first test asserts every derived count
  (`tables`, `columns`, `primaryKeys`, `foreignKeys`, `indexes`, `enums`) is `> 0` BEFORE any
  comparison runs. Raw stdout: `[derived-expected-counts] tables=74 columns=864 primaryKeys=74
  foreignKeys=136 indexes=42 enums=76 rlsEnabledTables=74`. Every per-category test additionally
  asserts its own `expectedCount`/`comparedCount` is `> 0`.
- **B. Silent omission in actual-state extraction?** This is the exact class of defect Codex
  found (expression index keys with `attnum=0` dropped by an `INNER JOIN pg_attribute`). Fixed
  via `pg_get_indexdef(indexrelid, position, true)` per position (never joins to `pg_attribute`,
  so nothing can fail to match) plus a structural completeness assertion
  (`extractedKeyCount === indnkeyatts`) checked against **all 129** actual indexes in the
  database, not only the 42 accepted ones (`totalActualIndexesChecked=129`,
  `keySlotCompletenessFailures=0`). Adversarial follow-up: does the SAME
  `unnest(...) INNER JOIN pg_attribute` pattern still used for primary keys and foreign keys
  share this vulnerability? No — PostgreSQL does not support expression-based primary keys or
  foreign keys; `pg_constraint.conkey`/`confkey` for `contype IN ('p','f')` can only ever contain
  real column attribute numbers (unlike `pg_index.indkey`, which is index-specific and does
  support `attnum=0` for expressions), so the `INNER JOIN pg_attribute` pattern is safe for those
  two categories specifically — this is a documented PostgreSQL constraint, not an assumption.
- **C. Semantic or name-only?** Semantic throughout: ordered PK/FK column sequences, real
  `pg_catalog.format_type()` strings (not TS type labels), ordered index key kind+value pairs,
  uniqueness flag, `INCLUDE` columns kept separate from keys, partial-index predicate text.
- **D. Raw output exists?** Yes — `01-schema-parity-and-index-extraction.stdout.txt` (non-empty,
  inspected directly) and `.stderr.txt`.
- **E. Exit status exists?** Yes — `.status.json`, `exitCode: 0`.
- **F. Corresponds to frozen current source?** Yes — `source-freeze.json` hashed
  `src/db/schemaParityComparators.ts`, `src/db/schemaParity.postgres.test.ts`,
  `src/db/indexExtraction.postgres.test.ts` before this step ran; `source-freeze-drift.json`
  confirms all three unchanged after every subsequent step, including this one.
- **G. Does the report claim more than this proves?** The closure report must NOT claim "every
  possible index shape was verified against the real schema" — the accepted schema's real 42
  indexes contain zero expression keys and zero `INCLUDE` columns today (reported honestly, not
  hidden); the corrected extraction's ability to handle those shapes is proven separately, by
  Mechanism 2 below, against constructed cases.
- **H. Could Codex reproduce a false positive with the current verifier?** The exact demonstrated
  shape is now a permanent regression test at BOTH the pure-comparator level (Mechanism 2) and
  the real-catalog level (`indexExtraction.postgres.test.ts` Case B, part of this same step) —
  reproducing it would require the test itself to fail, which it does not (exit 0).
  **Disclosed residual, not treated as blocking:** the fix has not been exhaustively fuzzed
  against every conceivable index construction (e.g., two expression keys in one index, an
  expression combined with explicit `DESC`/opclass modifiers). What IS proven generally, not just
  for the demonstrated shape, is the structural `extractedKeyCount === indnkeyatts` invariant —
  any silently-dropped position, of any shape, fails that check. This is judged sufficient
  because it targets the defect's actual mechanism (a position going missing), not just its one
  observed symptom.

## Mechanism 2 — comparator self-validation, including the named Codex regression (`02-verifier-self-validation.*`)

Backs the "verification framework is non-vacuous" claim generally, and specifically closes out
the Codex-demonstrated shape at the pure-fixture level; also exercises expression-only and
`INCLUDE` cases (real-catalog level in `01-*`'s own `indexExtraction.postgres.test.ts` half).

- **A. Empty expected set?** N/A for most of this suite (it feeds hand-built fixtures directly);
  the one derivation-regression test explicitly asserts `expected.primaryKeys.length >
  expected.tableNames.length === 0` is false (both equal 74, both `> 0`).
- **B. Silent omission?** This suite's entire purpose is proving the comparators DETECT omission/
  corruption — it does not itself extract from a database, so this question is answered by
  Mechanism 1 for the real extraction and by this suite for the comparison logic once given
  correct input.
- **C. Semantic or name-only?** Every corrupted-fixture test targets a specific semantic property
  (PK column order, FK target table, index uniqueness flag, index key kind, predicate text,
  `INCLUDE`-vs-key confusion) — never a bare name/count check.
- **D/E. Raw output & exit status?** `02-verifier-self-validation.stdout.txt`, `.status.json`,
  `exitCode: 0`, `34/34` tests.
- **F. Frozen source?** `src/db/schemaParityComparators.ts` and
  `src/db/schemaParityComparators.self-validation.test.ts` both hashed, zero drift.
- **G. Overclaim risk?** This suite proves the COMPARATOR LOGIC is correct — it does NOT by
  itself prove the real database has no defects (that is Mechanism 1's job). The closure report
  keeps these two claims distinct.
- **H. Could Codex reproduce a false positive?** The
  `INDEX-EXPRESSION-FALSE-POSITIVE-REGRESSION` test asserts `mismatches` has exactly one entry
  for Codex's exact demonstrated pair; if a regression reduced the actual definition back to the
  accepted one, `mismatches` would become `[]` and the test would fail. It passes (exit 0).

## Mechanism 3 — forward-upgrade proof (`03-forward-upgrade.*`)

Backs: DB-04, DB-05; G5-04, G5-05.

- **A. Empty expected set?** N/A (single seeded-row proof); the script throws if the seeded row
  is not found either before or after applying the Stage 5 migration, rather than silently
  passing on a missing row.
- **B. Silent omission?** The re-read query is `WHERE id = ${seedId}` (the exact UUID generated
  and inserted moments earlier) — cannot silently match a different, unrelated row.
- **C. Semantic?** Six named fields (`id`, `idempotency_key`, `status`, `amount_minor_units`,
  `currency`, `provider_name`) compared via `String(before) !== String(after)`, not a bare
  row-exists check. This is a semantic comparison of specific recorded field values, and the
  report describes it exactly that way — not as a byte/serialization comparison of the complete
  row, since no such comparison was performed.
- **D/E.** `03-forward-upgrade.stdout.txt`, `.status.json`, `exitCode: 0`.
- **F. Frozen source?** `scripts/stage5-forward-upgrade-test.mjs` hashed, zero drift.
- **G. Overclaim?** Corrected wording carried forward from the prior remediation round.
- **H.** Not applicable to index parity.

## Mechanism 4 — authoritative Supabase migration-runner proof (`04-migration-runner-proof.*`)

Backs: DB-09, DB-10, DB-11; G5-01, G5-10, G5-11, G5-12.

- **A. Empty expected set?** No — every phase asserts a specific nonzero tracked-migration count
  (58, then 57, then 58 again) read directly from `supabase_migrations.schema_migrations`, the
  Supabase CLI's own authoritative tracking table (not a table this script itself defines or
  writes to directly).
- **B. Silent omission?** The script reads the CLI's own JSON response (`{"applied": [...]}`)
  AND independently re-queries the tracking table after each run, cross-checking both — a bug
  that silently dropped a migration from the CLI's own bookkeeping would show up as a row-count
  mismatch against the expected count, which is asserted explicitly at each phase.
- **C. Semantic?** Exact migration VERSION IDENTIFIERS are compared before/after (not just
  counts) — e.g., Phase 2 asserts the pre-existing 57 identifiers are still present unchanged
  after the pending migration is applied.
- **D/E.** `04-migration-runner-proof.stdout.txt` shows all three phases; `.status.json`,
  `exitCode: 0` (the DELIBERATE nonzero exit inside Phase 3's own failure-run sub-step is an
  internal assertion target the script itself checks and reports on, not this step's own
  top-level exit code — the top-level `node scripts/stage5-migration-runner-proof.mjs` process
  exits 0 specifically because that intentional failure behaved exactly as required).
- **F. Frozen source?** `scripts/stage5-migration-runner-proof.mjs` hashed, zero drift.
- **G. Overclaim?** The report distinguishes the intentional Phase-3 sub-failure (part of the
  proof) from a real top-level failure (none occurred).
- **H.** Not index-related.

## Mechanism 5 — Stage 4 regression, reused and unexpanded (`05-stage4-regression.*`)

Backs: DB-06; G5-09.

- **A–F.** Same fixed 7-file, 37-test selector Stage 4 itself established; `.status.json`
  `exitCode: 0`; all 8 curated Stage 4 files hashed pre/post, zero drift, confirming this
  Stage's remediation touched none of them.
- **G.** The report does not claim this re-proves Stage 4's own original findings beyond
  regression containment — it only claims no Stage 5 change broke Stage 4's proven surface.
- **H.** N/A.

## Mechanism 6 — typecheck, lint, and three consecutive `npm test` runs

Backs: G5-14 (regression containment) directly; supports the general "material defects: 0" claim.

- **A–F.** `06-typecheck.status.json`/`07-lint.status.json` both `exitCode: 0`; all three
  `08/09/10-broader-regression-run-*.status.json` are `exitCode: 0`, with identical
  `261 files / 2289 tests` in every one of the three raw stdout captures (verified byte-identical
  test COUNTS across all three; full stdout preserved for each separately, not deduplicated).
  Zero code/test/config change between the three runs (source-freeze covers the entire campaign
  window, not just around step 01).
- **G. Overclaim risk?** The report states these results prove reproducibility across 3
  consecutive runs of the EXISTING suite — not that the suite is exhaustive or bug-free by
  construction.
- **H.** N/A.

## Cross-cutting: G5-13 (evidence preservation) and provider boundary

- G5-13: `manifest.json`/`manifest.md` (generated by
  `scripts/stage5-authoritative-manifest-and-check.mjs`) enumerate every required artifact and
  report `AUTHORITATIVE EVIDENCE MANIFEST VALIDATION: PASS` — a machine check, not a prose
  assertion. Historical evidence from all three prior remediation rounds remains on disk,
  untouched, under sibling directories (`stage5-evidence/` top level and `status/`).
- Provider boundary: rechecked in this round (see closure report Section T) — zero Adyen
  references in any file this remediation touched; `package.json`'s only diff (two pre-existing,
  protective npm-script aliases) predates this entire engagement.

## Overall preflight verdict

One honest, non-blocking residual disclosed (Mechanism 1.H: index-shape fuzzing is not
exhaustive, though the underlying completeness invariant is general). No weakness found that
would let Codex reproduce a false PASS, an empty-expected-set vacuity, a name-only comparison
masquerading as semantic, a missing raw-output/exit-status claim, or evidence attributed to
stale source. Stage 5 is judged ready for the closure report to be written.
