# Stage 5 — Codex-style adversarial preflight, V2 (source-freeze harness correction)

Two parts: (1) the freeze-logic-specific attack this order mandates (RULE 18), since the freeze
mechanism itself was the demonstrated defect this round fixes; (2) the six verification-mechanism
analyses carried forward from the prior round — unchanged in substance, since zero product/test
code changed this round, only the campaign harness's own source-freeze collector was rewritten.

## Part 1 — attacking the freeze logic itself (RULE 18)

1. **Can a leading-dot path disappear?** No longer by the mechanism that caused it. The prior
   collector parsed `git status --porcelain=v1` as human-readable text: it called `.trim()` on
   the ENTIRE multi-line output before slicing each line's fixed 3-character status prefix.
   Whenever the blob's first line began with a leading space (an ordinary unstaged-modified
   entry), that one whitespace character was eaten by the blob-level trim, shifting the
   fixed-width parse for THAT line and truncating `.github/workflows/ci.yml` to
   `github/workflows/ci.yml`. The corrected mechanism (`scripts/lib/freezeDiscovery.mjs`) never
   parses a status line at all — it splits Git's own NUL-delimited output
   (`git diff --name-only -z HEAD --`, `git ls-files --others --exclude-standard -z`) on the NUL
   byte, which has no escaping, no prefix, and nothing to trim. Proven directly:
   `authoritative-final-v2/source-freeze.json`'s `ciWorkflowEntry` shows
   `.github/workflows/ci.yml` present with its leading dot intact and a valid SHA-256; the
   harness self-test (`scripts/stage5-freeze-discovery.test.mjs`, 7/7 pass) asserts
   `paths[0][0] === "."` against a synthetic NUL-delimited string containing exactly this path.
2. **Can whitespace in a filename corrupt parsing?** No — NUL-delimited output has no
   whitespace-based field separation at all; a space inside a path is just another byte between
   two NUL bytes. Proven by the harness test `"parseNulDelimited preserves embedded whitespace in
   a filename exactly"` and `"classifyEntry: a path with a leading dot and a path with embedded
   spaces are both classified correctly"` (both pass).
3. **Can a deleted changed file be silently skipped?** No — `classifyEntry` never omits a path;
   for a path that does not exist on disk it returns `{exists:false, state:"deleted"}` rather
   than returning nothing. Proven by the harness test `"classifyEntry: a changed path that no
   longer exists on disk is represented as deleted, never silently skipped"` (pass), and
   structurally: `deriveFullChangedFileFreeze` builds `entries` by mapping directly over
   `changedPaths` — there is no code path that produces a `changedPaths` entry without a
   corresponding `entries` element.
4. **Can an untracked file be omitted?** No — the changed-path set is the explicit UNION of
   `git diff --name-only -z HEAD --` (tracked) and `git ls-files --others --exclude-standard -z`
   (untracked, non-ignored); the untracked call is unconditional, not gated on any flag. Proven
   by the harness test `"unionPaths includes a path present ONLY in the untracked set"` (pass),
   and directly observable in `authoritative-final-v2/git-untracked-raw-before.txt` (a real, raw,
   preserved capture of every untracked path this repository actually had at freeze time).
5. **Can the same incomplete collector generate matching before/after sets and falsely claim zero
   drift?** This was the exact residual risk RULE 14 names, and it is why the after-freeze is an
   INDEPENDENT re-invocation of `buildSourceFreeze("after")` — a second, real call to
   `git diff`/`git ls-files`, not a reuse of the before-freeze's own arrays. If the collector had
   an omission bug that behaved identically both times, drift comparison alone could not catch
   it — which is why the coverage invariant (item 7 below) is checked separately, on EACH
   freeze, not only in the before/after comparison.
6. **Is the changed-file set independently re-derived both before and after?** Yes —
   `authoritative-final-v2/source-freeze.json` and `source-freeze-after.json` each carry their
   own raw `git-tracked-changed-raw-{before,after}.txt` / `git-untracked-raw-{before,after}.txt`
   captures, from two genuinely separate child-process invocations
   (`scripts/stage5-authoritative-campaign.mjs`'s `buildSourceFreeze("before")` and
   `buildSourceFreeze("after")` calls), confirmed by their different `capturedAt` timestamps.
7. **Does every Git-reported path have a freeze entry?** Yes, checked twice: (a) structurally, by
   construction, since `entries = changedPaths.map(classifyEntry)`; (b) mechanically, by
   `scripts/stage5-authoritative-v2-manifest-and-check.mjs`'s mid-campaign coverage check, which
   independently re-verifies `changedCount === entryCount` and every changed path has a
   corresponding entry, for BOTH the before and after freeze snapshots, reading the already-
   written JSON files rather than trusting the campaign script's own in-memory claim.

```
SOURCE-FREEZE FALSE-PASS RESISTANCE: PASS
```

## Part 2 — the six verification mechanisms (carried forward; technical evidence identical to the prior round, since zero product/test code changed)

The full per-mechanism A–H analysis from the prior round remains valid without modification — the
same test files, same comparator code, same migration, same migration-runner-proof script
produced this round's `01`–`05` evidence, confirmed byte-identical in every printed count
(`tables=74 columns=864 primaryKeys=74 foreignKeys=136 indexes=42 enums=76`, `15/15`, `34/34`,
`37/37`, `261/261`+`2289/2289` ×3, `FORWARD UPGRADE: PASS` with the same cutoff/counts,
`MIGRATION RUNNER PROOF: PASS`), each independently re-run and re-captured this round under
`authoritative-final-v2/`, not copied from the prior round's files. Summary:

- **Schema-parity + index-extraction** (`01-*`): non-vacuous (all derived counts printed,
  nonzero); the Codex-demonstrated shape remains a permanent regression at both the pure-fixture
  and real-catalog level (`CODEX FALSE-POSITIVE REGRESSION: REJECTED AS EXPECTED`); PK/FK
  extraction confirmed structurally immune to the expression-key defect class (PostgreSQL
  disallows expression-based PK/FK constraints).
- **Verifier self-validation** (`02-*`): 34/34, proves comparators fail on corrupted fixtures, not
  merely pass on correct ones.
- **Forward-upgrade** (`03-*`): six named field values compared, row-existence checked both
  before and after, not vacuous.
- **Migration-runner proof** (`04-*`): applied-state, pending-only, and failure/retry all proven
  against the real `supabase_migrations.schema_migrations` tracking table, with version
  identifiers (not just counts) compared.
- **Stage 4 regression** (`05-*`): the same, unexpanded 7-file/37-test selector.
- **Typecheck/lint/3×npm-test** (`06`–`10`): zero errors, zero unexpected warnings, three
  independently-captured, byte-identical `261/2289` passes.

No report claim in this round exceeds what the newly-captured V2 evidence itself shows.

## Overall preflight verdict

Both the freeze-mechanism-specific attack (Part 1) and the six technical-mechanism attacks
(Part 2, carried forward) found no weakness that would let Codex reproduce a false PASS, a
silently-dropped changed path, a vacuous empty-expected-set, a name-only comparison, or evidence
attributed to a source state that was not actually frozen. Stage 5 is judged ready for the
closure report to be finalized on V2 evidence exclusively.
