# Stage 5 — Codex Independent Acceptance Report

## 1. Executive disposition and review provenance

**STAGE 5 INDEPENDENT TECHNICAL ACCEPTANCE: NOT VERIFIED**

The prior primary-key, column-type, authoritative migration-runner, and process-status blockers are resolved. One material verifier defect remains: the index catalog query can discard expression keys and falsely accept weakened uniqueness.

This file exports the completed independent review. It does not represent a new audit campaign or a reassessment of changes made after that review. The findings below are based on independently inspected current source, preserved execution evidence, and read-only, in-memory validation performed during that review. Codex did not rerun the database campaigns or engineering test suites.

The only repository write authorized for this export is creation of this report. No production code, migrations, tests, or evidence artifacts were modified. Final Project Owner acceptance remains exclusively the Project Owner's decision. Stage 6 is not authorized.

## 2. Repository verification

| Item | Verified value |
|---|---|
| Repository root | C:\Development\PAY2PAY-bank-v3 |
| Branch | architecture/bank-managed-payments-v3 |
| HEAD | 93bbbbf8950010d4c0a70c7133339dc352ebd0fd |
| Working tree | Intentionally uncommitted Stage 1–5 work, including the Stage 5 remediation |
| Sibling checkout | Not accessed |

Existing staged, unstaged, and untracked files were inspected and preserved. Lack of a commit is not an acceptance defect. The accumulated working-tree diff was not treated as exclusively Stage 5 work.

Applicable AGENTS.md and CLAUDE.md instructions were read. This was an independent verification review, not implementation or remediation.

## 3. Migration-history verification

No tracked historical migration was modified or deleted. No migration squashing or baseline replacement was identified.

The authoritative history reviewed is supabase/migrations/. The runner proof uses copies of this history in disposable scratch work directories. It does not substitute drizzle/migrations/.

The deliberate failure/retry migration is test-owned and resides only in the runner's scratch directory. Correcting that scratch migration is not a rewrite of an authoritative historical migration.

**HISTORICAL MIGRATIONS MODIFIED: 0**

## 4. Stage 5 migration verification

File: supabase/migrations/20260929000000_payment_attempt_status_stage5_parity.sql

The migration contains exactly two additive statements:

```sql
ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'refund_reversed';
ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'refund_failed';
```

The actual file includes the established statement-breakpoint separator. There is no destructive SQL, data deletion, table/column rename, grant change, or unrelated schema transformation.

The mismatch is genuine: the accepted application enum already requires these two values, while the preceding migration history lacks them. This is schema parity remediation, not a new payment feature.

The Stage 4 ledger-entry additions remain present and unchanged.

## 5. Schema-parity verification and expected-set completeness

Reviewed:

- src/db/schemaParityComparators.ts
- src/db/schemaParity.postgres.test.ts
- src/db/schema/**
- docs/remediation/stage5-evidence/status/final-campaign-02-schema-parity.json

Independent read-only evaluation of deriveExpectedSchema against the actual application schema produced:

| Category | Expected count | Recorded comparison |
|---|---:|---|
| Tables | 74 | 74 matched, 0 unmatched |
| Persisted columns | 864 | 864 matched, 0 unmatched |
| Primary keys | 74 | 0 mismatches |
| Foreign keys | 136 | 136 matched, 0 unmatched |
| Indexes | 42 | 0 missing, 0 reported semantic mismatches |
| Enums | 76 | 0 missing labels, 0 extra labels reported |
| RLS-enabled tables | 74 | Accepted enabled-state comparison passed |

The suite now asserts positive expected-set counts. The earlier zero-primary-key vacuous success is fixed.

However, the recorded index result is not sufficient to establish semantic index parity because the actual-index extraction loses expression keys. Section 8 documents the remaining defect.

**NON-VACUOUS EXPECTED-SET DERIVATION: VERIFIED**

**COMPLETE SCHEMA PARITY: NOT VERIFIED**

## 6. Column-type, nullability, and enum verification

The verifier compares application column.getSQLType() with PostgreSQL format_type(), keyed by table and column. It compares persisted enum type names and retains array type distinctions. Nullability is independently checked against pg_attribute.attnotnull.

The final raw evidence records 864 type comparisons and 864 nullability comparisons with zero mismatches.

Type normalization is narrowly defined:

- numeric precision/scale comma spacing;
- serial to integer;
- bigserial to bigint;
- smallserial to smallint.

These serial names describe DDL syntax rather than distinct stored PostgreSQL types. The self-validation suite rejects integer-to-text changes, bigint-to-integer changes, and numeric precision changes.

The enum comparison identifies missing and extra labels within expected enum types. Extra labels are reported rather than automatically failed. The current output reports neither missing nor extra labels.

Named checks confirm:

- payment_attempt_status includes refund_reversed and refund_failed;
- ledger_entry_type contains payment_cleared, refund, reversal, payout, dispute_adjustment, admin_adjustment, refund_correction, and payout_returned.

**COLUMN TYPE PARITY: VERIFIED**

**ENUM/TYPE PARITY: VERIFIED**

## 7. Primary-key and foreign-key verification

### Primary keys

deriveExpectedSchema now reads both table-level primary-key definitions and inline column.primary flags.

Independent evaluation found 74 expected primary keys, corresponding to all 74 current tables. Representative payment_attempt, payout_attempt, and audit_event keys are derived from their inline id declarations. The final PostgreSQL comparison reports zero PK mismatches, establishing 74 matched expected keys.

No composite primary key is present in the current accepted schema. Comparator self-validation covers missing and reordered composite components without claiming that those fixtures are current production composite keys.

**PRIMARY KEY PARITY VERIFIER: VERIFIED**

### Foreign keys

The actual-state query uses pg_constraint, pg_class, pg_namespace, and pg_attribute, pairing conkey and confkey entries by ordinality and grouping by constraint identity.

It compares referencing table, ordered referencing columns, referenced table, and ordered referenced columns. This avoids the prior information_schema privilege-visibility omission.

The final campaign records 136 expected and 136 matched foreign keys, with zero unmatched expectations.

**FOREIGN KEY PARITY: VERIFIED**

## 8. Index/unique semantic verification — remaining material defect

Source: src/db/schemaParity.postgres.test.ts:213–215.

The actual-index query expands pg_index.indkey and inner-joins every key slot to pg_attribute:

```sql
SELECT array_agg(a.attname ORDER BY k.ord)
FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a
  ON a.attrelid = ix.indrelid
 AND a.attnum = k.attnum
```

Expression keys have attribute number zero and disappear from this inner join. The query neither retains their expression definitions nor verifies that every index key slot survived extraction.

The comparator consequently receives an incomplete index definition.

### Concrete false-positive path

The accepted index payout_attempt_payment_attempt_id_unique enforces:

```sql
UNIQUE (payment_attempt_id)
```

An incorrect index with the same name and table could instead enforce:

```sql
UNIQUE (payment_attempt_id, lower(provider_name))
```

The current query drops the expression slot and represents that incorrect index to compareIndexesSemantic as:

```text
columns = ["payment_attempt_id"]
unique = true
predicateSql = null
```

That matches the accepted expected object, although the incorrect index permits multiple payout rows for one payment when provider names differ.

Codex performed an in-memory reproduction using the actual derived expected payout index and the actual comparator, modeling the query's loss of the expression slot. It returned:

```text
mismatches: []
missingNames: []
expectedCount: 1
```

This is a demonstrated current verifier false-positive. It is not a claim that the migrated database currently contains the incorrect index, and it is not a request for an unrelated hypothetical test.

Expected-schema derivation rejects expression indexes authored in the application schema, but that guard does not protect against expression keys introduced into the actual database index. The defect is on actual-state extraction.

Affected invariants: DB-02 and DB-07; DB-01 remains blocked because complete migration/schema parity is unsupported.

Affected gates: G5-02 and G5-06.

**INDEX/UNIQUE SEMANTIC PARITY: NOT VERIFIED**

## 9. RLS/security-schema verification

The final verifier compares accepted RLS-enabled flags with PostgreSQL and asserts the established empty policy set. It also checks the accepted absence of application functions and noninternal triggers.

The Stage 5 additive migration changes no grants, policies, security-definer functions, or RLS settings.

This verifies the accepted database-definition posture. It does not certify application authorization or RLS enforcement for a table-owner/BYPASSRLS connection.

**RLS/SECURITY-SCHEMA PARITY: VERIFIED**

## 10. Verifier self-validation

Source: src/db/schemaParityComparators.self-validation.test.ts.

Recorded result: 1 file, 30 tests passed, exit 0, preserved in status/final-campaign-03-verifier-self-validation.json.

The tests call the same comparison functions used by the PostgreSQL parity suite. They meaningfully cover:

- nonempty inline-primary-key derivation;
- missing and incorrect PKs;
- composite PK component/order changes;
- incompatible types and nullability;
- missing or repointed FKs;
- missing indexes, lost uniqueness, reordered columns, and changed/dropped predicates;
- missing enum labels and reporting of additional labels.

They are comparator tests over in-memory fixtures, not corrupted-database integration tests.

Critically, the index tests supply already-extracted index objects. They do not exercise the catalog extraction that discards expression keys. The passing count therefore does not resolve the false-positive path in Section 8.

**SELF-VALIDATION EXECUTION: 30/30 PASS, EXIT 0**

**OVERALL VERIFIER FALSE-POSITIVE RESISTANCE: NOT VERIFIED**

## 11. Authoritative Supabase migration-runner verification

Reviewed scripts/stage5-migration-runner-proof.mjs and its captured child-process sidecars.

The actual mechanism is:

```text
npx supabase migration up --db-url <disposable-local-target> --workdir <scratch-copy> --include-all --yes
```

It uses copies of supabase/migrations/ and persists state in supabase_migrations.schema_migrations. The fresh SQL-file runner is no longer offered as proof of applied-state tracking.

The runner creates a disposable postgres:17-alpine container with a loopback-bound port and separate databases for its three phases. The proof targets are generated locally rather than taken from an inherited production database URL.

**AUTHORITATIVE MIGRATION RUNNER: VERIFIED**

## 12. Applied-state and pending-only proof

| Phase | Captured result |
|---|---|
| Full first run | 58 migrations applied; exit 0 |
| Immediate rerun | 0 applied; exit 0; tracked count and version set unchanged |
| Partial-state first run | 57 preceding migrations applied; exit 0 |
| Apply pending Stage 5 migration | Exactly 20260929000000_payment_attempt_status_stage5_parity.sql applied; exit 0; 58 tracked |
| Subsequent full-state rerun | 0 applied; exit 0 |

The script queries persisted migration state and asserts these conditions. The raw sidecars independently preserve the authoritative runner's applied-file output and process statuses.

Evidence includes db09-applied-state-run-a/b.json, pending-only-run-a/b.json, pending-only-partial-state-proof.json, and stage5-migration-runner-proof-summary.json.

**APPLIED-STATE PERSISTENCE: VERIFIED**

**PENDING-ONLY MIGRATION APPLICATION: VERIFIED**

## 13. Migration failure/retry proof

The test-owned scratch migration creates stage5_retry_proof_scratch and deliberately executes SELECT 1/0.

The final proof establishes:

1. Deliberate failure exits 1 with SQLSTATE 22012.
2. The scratch table is absent after failure.
3. Only the 57 preceding migrations are tracked; the failed version is absent.
4. The failure condition is removed from the scratch copy only.
5. Normal Supabase migration application succeeds on retry, exit 0.
6. The scratch table exists and its migration version is recorded.
7. A further invocation applies zero migrations, exit 0.

The script asserts rollback and persisted-state properties before reporting success. No authoritative historical migration is modified.

Evidence: status/failure-run.json, status/retry-run.json, status/retry-rerun-idempotent.json, and the successful parent runner-proof sidecar.

**MIGRATION FAILURE/RETRY: VERIFIED**

## 14. Fresh-build verification

The final Stage 5 campaign creates a disposable PostgreSQL target, records container/database identity and ownership checks, and applies all 58 migrations from zero.

No migration is skipped. No manual repair SQL is required. The established anon/authenticated/storage structural bootstrap remains distinct from application migration repair.

The parity campaign exits 0.

**FRESH DATABASE BUILD: VERIFIED**

## 15. Forward-upgrade and data-preservation verification

The final forward-upgrade command exits 0.

Its cutoff is 20260928000000_ledger_entry_type_stage4_parity.sql, the 57th migration and immediate predecessor of Stage 5.

The script:

1. Applies the 57-migration prefix.
2. Seeds a representative payment with status succeeded and amount 12345.
3. Records six fields.
4. Applies the one Stage 5 migration.
5. Rereads and compares those fields.
6. Reports payment_attempt row count 1.

The compared fields are id, idempotency_key, status, amount_minor_units, currency, and provider_name.

The comparison uses string equality of persisted field values, not literal bytewise serialization of the complete row. The closure report still overstates this as byte-for-byte. That wording error does not invalidate the representative semantic-preservation proof for this exclusively additive migration.

**FORWARD UPGRADE: VERIFIED**

**DATA PRESERVATION: VERIFIED**

## 16. Stage 4 and Stage 5 campaign verification

| Campaign | Raw recorded result | Exit |
|---|---|---:|
| Corrected Stage 5 parity selector | 1 file / 10 tests passed | 0 |
| Verifier self-validation | 1 file / 30 tests passed | 0 |
| Stage 4 PostgreSQL regression | 7 files / 37 tests passed | 0 |

The final Stage 5 selector uses the corrected verifier. No acceptance-critical skip, todo, or accidental only selection was identified.

The 10 passing parity tests are genuine recorded executions, but they do not compensate for the extraction defect in Section 8.

Stage 4's passing regression is preserved; no Stage 4 financial defect was demonstrated by this review.

## 17. Engineering-regression verification

| Check | Final captured result |
|---|---|
| Typecheck | Exit 0 |
| Lint | Exit 0; 0 errors and 12 pre-existing warnings outside Stage 5 changes |
| Broader npm test | 261 files / 2,285 tests passed; exit 0 |

The broader count is consistent: the prior 260 files / 2,255 tests plus the new self-validation file and its 30 cases.

All results were read from final campaign sidecars, not inferred from absence of console errors. Codex did not rerun these commands.

## 18. Final campaign source consistency and evidence integrity

Campaign window:

- Start: 2026-09-29T13:26:53.362Z
- Finish: 2026-09-29T13:28:48.289Z

Reviewed scripts/stage5-final-campaign.mjs, scripts/lib/statusSidecar.mjs, all eight acceptance-critical command sidecars, nested Supabase command sidecars, and final-campaign-summary.json.

Each acceptance-critical command has:

- command;
- working directory;
- timestamp;
- stdout;
- stderr;
- captured numeric process status.

All eight required campaign commands exited 0. The deliberately failing nested migration process exited 1 as required; retry exited 0.

Sidecar timestamps fall within the final campaign window. Current file timestamps under src/, scripts/, and supabase/migrations/ show no modifications after campaign start. This is source/timestamp consistency evidence, not cryptographic attestation.

The script's built-in integrity check checks sidecar existence and numeric status; Codex independently checked timestamp consistency rather than relying on the report's stronger description of that check.

The previous missing-status blocker is resolved. Historical pre-remediation outputs are explicitly distinguished from the authoritative final sidecars.

**FINAL CAMPAIGN SOURCE CONSISTENCY: VERIFIED on the inspected source/timestamp evidence**

**ALL REQUIRED FINAL PROCESS EXIT CODES: VERIFIED**

**EVIDENCE PACKAGE INTEGRITY: VERIFIED**

## 19. Contradiction audit and stage boundaries

The final raw test counts, migration counts, and process statuses agree with the final sidecars.

Remaining report qualifications:

1. The report still calls semantic field comparison byte-for-byte.
2. The report substitutes different meanings for G5 identifiers. This independent report uses the Project Owner's specified gate definitions instead.
3. The report's claim of complete semantic index verification is materially contradicted by the false-positive path in Section 8.

The first two are reporting inaccuracies; they do not independently invalidate successful executions. The third is the material remaining acceptance blocker.

No new banking/provider dependency was identified in the Stage 5 changes. The reviewed execution targets are disposable local databases. No Stage 5 production/shared/staging access, real-provider operation, production deployment, or Stage 6 implementation was identified.

Commit/push was not performed as part of this review.

## 20. DB-01 through DB-12 matrix

| Invariant | Disposition | Basis |
|---|---|---|
| DB-01 Migration completeness | BLOCKED | Complete semantic migration/schema parity remains unsupported because of index extraction |
| DB-02 Schema parity | NOT VERIFIED | Actual-index extraction can falsely accept weakened uniqueness |
| DB-03 Fresh-build reproducibility | VERIFIED | 58 migrations; disposable target; exit 0 |
| DB-04 Forward-upgrade reproducibility | VERIFIED | Correct 57-migration cutoff, one pending additive migration, preserved fixture |
| DB-05 Data preservation | VERIFIED | Recorded field values and row count preserved; no transformation |
| DB-06 Financial-invariant preservation | VERIFIED | Stage 4 37-test regression passes |
| DB-07 Constraint/index parity | NOT VERIFIED | Expression index keys are silently dropped |
| DB-08 RLS/security-schema parity | VERIFIED | Accepted enabled-state/policy/function/trigger checks |
| DB-09 Migration runner correctness | VERIFIED | Authoritative Supabase tracking, pending-only, and retry proof |
| DB-10 Migration ordering safety | VERIFIED | Prefix/full-chain and pending-only execution |
| DB-11 Historical migration immutability | VERIFIED | No historical rewrite; scratch failure migration is separate |
| DB-12 No manual production SQL dependency | VERIFIED | Normal runner proof requires no production repair SQL |

## 21. G5-01 through G5-14 matrix

These are the Project Owner's gate definitions, not the replacement mapping in Claude's report.

| Gate | Disposition | Basis |
|---|---|---|
| G5-01 Migration-history integrity | VERIFIED | No historical migration rewrite |
| G5-02 Schema parity | NOT VERIFIED | Index extraction false-positive |
| G5-03 Fresh-build reproducibility | VERIFIED | 58 migrations and successful captured process |
| G5-04 Forward-upgrade reproducibility | VERIFIED | Correct cutoff and successful upgrade |
| G5-05 Data preservation | VERIFIED | Representative values preserved |
| G5-06 Constraint parity | NOT VERIFIED | Weakened uniqueness can falsely pass |
| G5-07 Enum/type parity | VERIFIED | Current type and enum comparisons pass |
| G5-08 RLS/security-schema parity | VERIFIED | Accepted security-definition posture preserved |
| G5-09 Stages 1–4 invariant preservation | VERIFIED | Final Stage 4 regression preserved |
| G5-10 Deployment ordering defined | VERIFIED | Previously established migration-first, then dependent application order |
| G5-11 Failure/retry procedure defined | VERIFIED | Authoritative transactional failure/retry demonstrated |
| G5-12 No manual production SQL dependency | VERIFIED | Normal migration application and retry |
| G5-13 Evidence preservation | VERIFIED | Required command/status sidecars present |
| G5-14 Regression containment | VERIFIED | Final regression results and source consistency |

## 22. Remaining material defect and final independent disposition

One material verification defect remains. The additive Stage 5 migration itself has no identified material defect, and the successful recorded migration and regression executions are not being rejected as failed tests.

The minimum closure property still required is that actual-index extraction preserve or explicitly reject expression keys and that the demonstrated false-positive path be rejected by the verifier. Codex has not implemented that correction or modified any acceptance evidence.

Final Project Owner acceptance remains pending. Production migration execution and Stage 6 are not authorized.

STAGE 5 INDEPENDENT TECHNICAL ACCEPTANCE: NOT VERIFIED

- Exact remaining blocker: src/db/schemaParity.postgres.test.ts:213–215 silently drops expression keys from actual index metadata. An incorrect UNIQUE (payment_attempt_id, lower(provider_name)) index with the accepted payout index name is reduced to the expected single-column representation, and the actual comparator returns no mismatches. This prevents verification of DB-02/DB-07, leaves DB-01 blocked, and fails G5-02/G5-06. Closure requires evidence that actual-index extraction preserves or explicitly rejects expression keys and that this false-positive path is rejected.
