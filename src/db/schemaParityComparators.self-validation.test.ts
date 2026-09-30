/**
 * Stage 5 — verifier self-validation (Part II, Step 9 of the zero-false-positive completion
 * order). Proves the schema-parity comparators themselves catch real defects, not merely that
 * they pass on a correct schema. Every test below feeds a deliberately corrupted "actual" (or
 * "expected") fixture into the exact same comparator function the real-Postgres parity test
 * uses, and asserts the comparator reports the corruption — the inverse of the real test's own
 * assertions. This is a plain, non-Postgres unit test (runs under `npm test`, not the disposable
 * harness) because every comparator under test is a pure function over in-memory data.
 */
import { describe, expect, it } from "vitest";
import {
  compareColumnTypes,
  compareEnumsBidirectional,
  compareForeignKeys,
  compareIndexesSemantic,
  compareNameSets,
  compareNullability,
  comparePrimaryKeys,
  deriveExpectedSchema,
  derivePredicateSql,
  normalizeTypeString,
  type ActualIndex,
  type ExpectedColumn,
  type ExpectedEnum,
  type ExpectedForeignKey,
  type ExpectedIndex,
  type ExpectedPrimaryKey,
} from "@/db/schemaParityComparators";
import { sql } from "drizzle-orm";
import { pgTable, unique, uuid } from "drizzle-orm/pg-core";
import * as realSchema from "@/db/schema";

describe("Stage 5 verifier self-validation: expected-set derivation regression guards", () => {
  it("deriveExpectedSchema captures inline single-column primary keys (getTableConfig().primaryKeys alone misses these entirely)", () => {
    // Regression guard for a real gap this Stage's own remediation found: this schema authors
    // every primary key inline on the column itself (`.primaryKey()`), never via the table's
    // `(table) => [primaryKey(...)]` composite-PK callback form. The first version of
    // deriveExpectedSchema only read the latter and silently derived primaryKeys.length === 0
    // across all 74 tables — which would have made comparePrimaryKeys pass vacuously (an empty
    // expected array trivially has zero unmatched entries) had the completeness assertion
    // (expectedCount > 0) not caught it first.
    const expected = deriveExpectedSchema(realSchema as unknown as Record<string, unknown>);
    expect(expected.primaryKeys.length).toBeGreaterThan(0);
    expect(expected.primaryKeys.length).toBe(expected.tableNames.length); // every table here has exactly one single-column PK.
    const paymentAttemptPk = expected.primaryKeys.find((pk) => pk.table === "payment_attempt");
    expect(paymentAttemptPk?.columns).toEqual(["id"]);
  });

  it("deriveExpectedSchema throws rather than silently omitting if a table-level unique() constraint is ever introduced", () => {
    // This repository has zero table-level unique() constraints today (every uniqueness contract
    // is authored via uniqueIndex()) — deriveExpectedSchema asserts this invariant explicitly
    // rather than silently deriving an empty, misleadingly-complete-looking unique-constraints
    // category forever. Exercised here against a hand-built fixture table (never a real, mutated
    // production schema) using the real drizzle-orm table builder.
    const fixtureTable = pgTable(
      "fixture_with_table_level_unique",
      { id: uuid("id").primaryKey(), other: uuid("other").notNull() },
      (t) => [unique("fixture_other_unique").on(t.other)],
    );
    expect(() => deriveExpectedSchema({ fixtureTable } as unknown as Record<string, unknown>)).toThrow(/table-level unique constraint/);
  });
});

describe("Stage 5 verifier self-validation: comparators MUST fail on a corrupted schema", () => {
  it("compareNameSets: correct schema passes (control case)", () => {
    const result = compareNameSets(["a", "b", "c"], ["a", "b", "c"]);
    expect(result.unmatchedExpected).toEqual([]);
    expect(result.matchedCount).toBe(3);
  });

  it("compareNameSets: a table removed from the database is caught", () => {
    const result = compareNameSets(["payment_attempt", "agreement", "user_account"], ["payment_attempt", "agreement"]);
    expect(result.unmatchedExpected).toEqual(["user_account"]);
    expect(result.matchedCount).toBe(2);
  });

  it("column type: correct schema passes (control case)", () => {
    const expected: ExpectedColumn[] = [{ table: "t", column: "amount", sqlType: "integer", notNull: true }];
    const { mismatches } = compareColumnTypes(expected, [{ key: "t.amount", pgType: "integer" }]);
    expect(mismatches).toEqual([]);
  });

  it("column type: a column silently changed from integer to text is caught", () => {
    const expected: ExpectedColumn[] = [{ table: "payment_attempt", column: "amount_minor_units", sqlType: "integer", notNull: true }];
    const { mismatches, comparedCount } = compareColumnTypes(expected, [{ key: "payment_attempt.amount_minor_units", pgType: "text" }]);
    expect(comparedCount).toBe(1);
    expect(mismatches).toEqual([`payment_attempt.amount_minor_units: expected="integer" actual="text"`]);
  });

  it("column type: bigserial/serial DDL-sugar normalizes to its real stored base type (bigint/integer), confirmed against a real migrated database", () => {
    const expected: ExpectedColumn[] = [{ table: "audit_event", column: "id", sqlType: "bigserial", notNull: true }];
    const { mismatches } = compareColumnTypes(expected, [{ key: "audit_event.id", pgType: "bigint" }]);
    expect(mismatches).toEqual([]);
  });

  it("column type: the serial-sugar normalization does not mask a real bigint-vs-integer type change", () => {
    const expected: ExpectedColumn[] = [{ table: "t", column: "id", sqlType: "bigserial", notNull: true }];
    const { mismatches } = compareColumnTypes(expected, [{ key: "t.id", pgType: "integer" }]);
    expect(mismatches).toEqual([`t.id: expected="bigserial" actual="integer"`]);
  });

  it("column type: the one documented normalization rule (numeric comma-spacing) does not mask a real precision/scale change", () => {
    const expected: ExpectedColumn[] = [{ table: "beneficial_owner", column: "ownership_percent", sqlType: "numeric(5, 2)", notNull: false }];
    // A real precision change (5,2) -> (6,2) must still be caught even after comma-spacing normalization.
    const { mismatches } = compareColumnTypes(expected, [{ key: "beneficial_owner.ownership_percent", pgType: "numeric(6,2)" }]);
    expect(mismatches).toHaveLength(1);
    expect(normalizeTypeString("numeric(5, 2)")).toBe(normalizeTypeString("numeric(5,2)")); // the rule does fire for spacing-only differences
  });

  it("nullability: correct schema passes (control case)", () => {
    const expected: ExpectedColumn[] = [{ table: "t", column: "c", sqlType: "text", notNull: true }];
    const { mismatches } = compareNullability(expected, [{ key: "t.c", nullable: false }]);
    expect(mismatches).toEqual([]);
  });

  it("nullability: a NOT NULL column silently made nullable in the database is caught", () => {
    const expected: ExpectedColumn[] = [{ table: "payment_attempt", column: "provider_name", sqlType: "text", notNull: true }];
    const { mismatches } = compareNullability(expected, [{ key: "payment_attempt.provider_name", nullable: true }]);
    expect(mismatches).toEqual([`payment_attempt.provider_name: expected.notNull=true actual.is_nullable=true`]);
  });

  it("primary key: correct schema passes (control case)", () => {
    const expected: ExpectedPrimaryKey[] = [{ table: "t", columns: ["id"] }];
    const { mismatches } = comparePrimaryKeys(expected, [{ table: "t", columns: ["id"] }]);
    expect(mismatches).toEqual([]);
  });

  it("primary key: removed entirely from the database is caught", () => {
    const expected: ExpectedPrimaryKey[] = [{ table: "payment_attempt", columns: ["id"] }];
    const { mismatches } = comparePrimaryKeys(expected, []);
    expect(mismatches).toEqual([`payment_attempt: expected PK columns [id] but table has no PK in the database`]);
  });

  it("primary key: changed to the wrong column is caught", () => {
    const expected: ExpectedPrimaryKey[] = [{ table: "payment_attempt", columns: ["id"] }];
    const { mismatches } = comparePrimaryKeys(expected, [{ table: "payment_attempt", columns: ["idempotency_key"] }]);
    expect(mismatches).toEqual([`payment_attempt: expected PK columns [id] (ordered) but database has [idempotency_key]`]);
  });

  it("primary key: a composite PK missing one component is caught", () => {
    const expected: ExpectedPrimaryKey[] = [{ table: "agreement_party_snapshot", columns: ["agreement_version_id", "party_role"] }];
    const { mismatches } = comparePrimaryKeys(expected, [{ table: "agreement_party_snapshot", columns: ["agreement_version_id"] }]);
    expect(mismatches).toEqual([
      `agreement_party_snapshot: expected PK columns [agreement_version_id,party_role] (ordered) but database has [agreement_version_id]`,
    ]);
  });

  it("primary key: reordered composite columns are caught (order is semantic)", () => {
    const expected: ExpectedPrimaryKey[] = [{ table: "t", columns: ["a", "b"] }];
    const { mismatches } = comparePrimaryKeys(expected, [{ table: "t", columns: ["b", "a"] }]);
    expect(mismatches).toHaveLength(1);
  });

  it("foreign key: correct schema passes (control case)", () => {
    const fk: ExpectedForeignKey = { table: "payment_attempt", columns: ["agreement_id"], foreignTable: "agreement", foreignColumns: ["id"] };
    const result = compareForeignKeys([fk], [fk]);
    expect(result.unmatchedExpected).toEqual([]);
  });

  it("foreign key: removed from the database is caught", () => {
    const expected: ExpectedForeignKey[] = [{ table: "payment_attempt", columns: ["agreement_id"], foreignTable: "agreement", foreignColumns: ["id"] }];
    const result = compareForeignKeys(expected, []);
    expect(result.unmatchedExpected).toEqual(["payment_attempt(agreement_id)->agreement(id)"]);
  });

  it("foreign key: pointed at the wrong referenced table is caught", () => {
    const expected: ExpectedForeignKey[] = [{ table: "payment_attempt", columns: ["agreement_id"], foreignTable: "agreement", foreignColumns: ["id"] }];
    const actual: ExpectedForeignKey[] = [{ table: "payment_attempt", columns: ["agreement_id"], foreignTable: "agreement_version", foreignColumns: ["id"] }];
    const result = compareForeignKeys(expected, actual);
    expect(result.unmatchedExpected).toEqual(["payment_attempt(agreement_id)->agreement(id)"]);
    expect(result.unexpectedActual).toEqual(["payment_attempt(agreement_id)->agreement_version(id)"]);
  });

  // --- Index model helpers -------------------------------------------------------------------
  // ExpectedIndex.keys / ActualIndex.keys hold ordered {kind, value} pairs, never bare column-name
  // strings — this is the exact model change the Codex false-positive remediation required
  // (Section 4 of the order). columnKeys() is a terse constructor for the common "all ordinary
  // columns" shape; actualFromExpected() builds a matching ActualIndex (with indnkeyatts/
  // extractedKeyCount consistent by construction) for control-case fixtures.
  function columnKeys(...names: string[]): ExpectedIndex["keys"] {
    return names.map((value) => ({ kind: "column" as const, value }));
  }
  function actualFromExpected(idx: ExpectedIndex, overrides: Partial<ActualIndex> = {}): ActualIndex {
    return {
      name: idx.name,
      table: idx.table,
      keys: idx.keys,
      includeColumns: idx.includeColumns,
      unique: idx.unique,
      predicateSql: idx.predicateSql,
      extractedKeyCount: idx.keys.length,
      indnkeyatts: idx.keys.length,
      ...overrides,
    };
  }

  it("unique/semantic index: correct schema passes (control case)", () => {
    const idx: ExpectedIndex = { name: "payment_attempt_idempotency_key_unique", table: "payment_attempt", keys: columnKeys("idempotency_key"), includeColumns: [], unique: true, predicateSql: null };
    const { mismatches, missingNames, keySlotCompletenessFailures } = compareIndexesSemantic([idx], [actualFromExpected(idx)]);
    expect(mismatches).toEqual([]);
    expect(missingNames).toEqual([]);
    expect(keySlotCompletenessFailures).toEqual([]);
  });

  it("index: missing from the database entirely is caught", () => {
    const idx: ExpectedIndex = { name: "payment_attempt_idempotency_key_unique", table: "payment_attempt", keys: columnKeys("idempotency_key"), includeColumns: [], unique: true, predicateSql: null };
    const { missingNames } = compareIndexesSemantic([idx], []);
    expect(missingNames).toEqual(["payment_attempt_idempotency_key_unique"]);
  });

  it("index: silently demoted from UNIQUE to non-unique is caught (name-only comparison would miss this)", () => {
    const idx: ExpectedIndex = { name: "payment_attempt_idempotency_key_unique", table: "payment_attempt", keys: columnKeys("idempotency_key"), includeColumns: [], unique: true, predicateSql: null };
    const actual = actualFromExpected(idx, { unique: false });
    const { mismatches } = compareIndexesSemantic([idx], [actual]);
    expect(mismatches).toEqual([`payment_attempt_idempotency_key_unique: unique: expected=true actual=false`]);
  });

  it("index: columns reordered is caught (name-only comparison would miss this)", () => {
    const idx: ExpectedIndex = { name: "idx_composite", table: "t", keys: columnKeys("a", "b"), includeColumns: [], unique: false, predicateSql: null };
    const actual = actualFromExpected(idx, { keys: columnKeys("b", "a") });
    const { mismatches } = compareIndexesSemantic([idx], [actual]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("keys:");
  });

  it("index: a partial index's WHERE predicate silently dropped is caught (name-only comparison would miss this)", () => {
    const idx: ExpectedIndex = {
      name: "admin_role_assignment_active_user_unique",
      table: "admin_role_assignment",
      keys: columnKeys("user_id"),
      includeColumns: [],
      unique: true,
      predicateSql: "revoked_at IS NULL",
    };
    const actual = actualFromExpected(idx, { predicateSql: null });
    const { mismatches } = compareIndexesSemantic([idx], [actual]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("predicate:");
  });

  it("index: a partial index's WHERE predicate silently changed to a different condition is caught", () => {
    const idx: ExpectedIndex = {
      name: "reconciliation_exception_open_identity_unique",
      table: "reconciliation_exception",
      keys: columnKeys("payment_attempt_id"),
      includeColumns: [],
      unique: true,
      predicateSql: "status = 'open'",
    };
    const actual = actualFromExpected(idx, { predicateSql: "status = 'closed'" });
    const { mismatches } = compareIndexesSemantic([idx], [actual]);
    expect(mismatches).toHaveLength(1);
  });

  it("INDEX-EXPRESSION-FALSE-POSITIVE-REGRESSION — the exact Codex-demonstrated defect: an accepted UNIQUE(payment_attempt_id) must NOT match an actual UNIQUE(payment_attempt_id, lower(provider_name))", () => {
    // This reproduces, byte-for-byte, the shape Codex demonstrated: the accepted application
    // schema authorizes only UNIQUE(payment_attempt_id); the real database actually has
    // UNIQUE(payment_attempt_id, lower(provider_name)) — a materially weaker/different
    // constraint (it permits duplicate payment_attempt_id values differing only in
    // provider_name's case). The prior extraction's inner-join-to-pg_attribute approach
    // silently dropped the expression key (attnum=0 matches no pg_attribute row), so the
    // comparator saw actual columns=["payment_attempt_id"] and reported no mismatch — a false
    // positive for parity. This must now be a real, reported MISMATCH.
    const expected: ExpectedIndex = {
      name: "reconciliation_exception_open_identity_unique",
      table: "reconciliation_exception",
      keys: columnKeys("payment_attempt_id"),
      includeColumns: [],
      unique: true,
      predicateSql: null,
    };
    const actualWeakened: ActualIndex = {
      name: "reconciliation_exception_open_identity_unique",
      table: "reconciliation_exception",
      keys: [
        { kind: "column", value: "payment_attempt_id" },
        { kind: "expression", value: "lower(provider_name)" },
      ],
      includeColumns: [],
      unique: true,
      predicateSql: null,
      extractedKeyCount: 2,
      indnkeyatts: 2,
    };
    const { mismatches } = compareIndexesSemantic([expected], [actualWeakened]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("keys:");
    expect(mismatches[0]).toContain("expected=[column:payment_attempt_id]");
    expect(mismatches[0]).toContain("actual=[column:payment_attempt_id,expression:lower(provider_name)]");
    // The test itself must fail (not silently pass) if a regression reduces the incorrect
    // actual definition back down to the accepted one:
    expect(mismatches).not.toEqual([]);
  });

  it("index key-slot completeness: an extraction that silently drops a key position is caught, independent of any expected-schema comparison", () => {
    // Part I Step 9's permanent guard: extracted_key_count must equal pg_index.indnkeyatts for
    // EVERY actual index, whether or not that index even appears in the expected set. Simulates
    // exactly the old bug's symptom — indnkeyatts says 2 key positions exist, but only 1 was
    // actually extracted (the expression position silently disappeared).
    const brokenExtraction: ActualIndex = {
      name: "some_index",
      table: "t",
      keys: [{ kind: "column", value: "payment_attempt_id" }],
      includeColumns: [],
      unique: true,
      predicateSql: null,
      extractedKeyCount: 1,
      indnkeyatts: 2,
    };
    const { keySlotCompletenessFailures } = compareIndexesSemantic([], [brokenExtraction]);
    expect(keySlotCompletenessFailures).toEqual(["some_index: extracted 1 key(s) but pg_index.indnkeyatts=2"]);
  });

  it("index: an expression-only index is preserved as one expression key, never zero keys", () => {
    const idx: ActualIndex = {
      name: "case_c_expr_only",
      table: "t",
      keys: [{ kind: "expression", value: "lower(provider_name)" }],
      includeColumns: [],
      unique: false,
      predicateSql: null,
      extractedKeyCount: 1,
      indnkeyatts: 1,
    };
    expect(idx.keys.length).toBeGreaterThan(0);
    const { keySlotCompletenessFailures } = compareIndexesSemantic([], [idx]);
    expect(keySlotCompletenessFailures).toEqual([]);
  });

  it("index: an INCLUDE column is never confused with a uniqueness key — UNIQUE(a) INCLUDE(b) is not UNIQUE(a,b)", () => {
    const acceptedSingleKey: ExpectedIndex = {
      name: "case_d_include",
      table: "t",
      keys: columnKeys("payment_attempt_id"),
      includeColumns: [],
      unique: true,
      predicateSql: null,
    };
    const actualWithInclude: ActualIndex = {
      name: "case_d_include",
      table: "t",
      keys: [{ kind: "column", value: "payment_attempt_id" }], // only the real key — provider_name is NOT here.
      includeColumns: ["provider_name"],
      unique: true,
      predicateSql: null,
      extractedKeyCount: 1,
      indnkeyatts: 1,
    };
    // The accepted schema (drizzle has no .include() support here) expects zero INCLUDE columns,
    // so a real INCLUDE column the database has is itself reported as a mismatch — it is never
    // silently accepted, and it is never treated as if it were a second uniqueness key.
    const { mismatches, keySlotCompletenessFailures } = compareIndexesSemantic([acceptedSingleKey], [actualWithInclude]);
    expect(keySlotCompletenessFailures).toEqual([]); // extraction itself is complete (1 key == indnkeyatts=1).
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("includeColumns:");
    expect(mismatches[0]).not.toContain("keys:"); // critically: the KEY sequence itself still matches — this is not a key mismatch.
  });

  it("derivePredicateSql normalization matches PostgreSQL's own pg_get_expr() rendering, for every predicate shape this schema actually uses", () => {
    // Ground truth pairs captured empirically against a real migrated database during this
    // Stage's own remediation (docs/remediation/stage5-evidence/
    // index-predicate-normalization-probe.txt): drizzle's PgDialect().sqlToQuery(idx.config.where)
    // rendering (left) vs. the SAME real, migrated index's pg_get_expr(indpred, indrelid)
    // rendering as returned by PostgreSQL itself (right, already run through derivePredicateSql
    // the same way the real parity test runs it on the actual side).
    const cases: [drizzleRendering: string, postgresRenderingNormalized: string][] = [
      [`"business_staff_member"."removed_at" IS NULL`, derivePredicateSql(sql.raw(`(removed_at IS NULL)`))],
      [`"audit_event"."provider_event_id" IS NOT NULL`, derivePredicateSql(sql.raw(`(provider_event_id IS NOT NULL)`))],
      [`"business_staff_invitation"."status" = 'pending'`, derivePredicateSql(sql.raw(`(status = 'pending'::staff_invitation_status)`))],
      [`"reconciliation_exception"."status" = 'open'`, derivePredicateSql(sql.raw(`(status = 'open'::reconciliation_exception_status)`))],
      [`"relationship_financial_account"."status" = 'active'`, derivePredicateSql(sql.raw(`(status = 'active'::relationship_financial_account_assignment_status)`))],
    ];
    for (const [drizzleRendering, postgresRenderingNormalized] of cases) {
      expect(derivePredicateSql(sql.raw(drizzleRendering))).toBe(postgresRenderingNormalized);
    }
  });

  it("derivePredicateSql: an actually-different predicate is NOT masked by the cast-stripping normalization rule", () => {
    const pending = derivePredicateSql(sql.raw(`(status = 'pending'::staff_invitation_status)`));
    const accepted = derivePredicateSql(sql.raw(`(status = 'accepted'::staff_invitation_status)`));
    expect(pending).not.toBe(accepted);
  });

  it("enum: correct schema passes (control case)", () => {
    const expected: ExpectedEnum[] = [{ enumName: "payment_attempt_status", values: ["pending", "succeeded"] }];
    const actual = [{ enumName: "payment_attempt_status", values: ["pending", "succeeded"] }];
    const { missingInDb, extraInDb } = compareEnumsBidirectional(expected, actual);
    expect(missingInDb).toEqual([]);
    expect(extraInDb).toEqual([]);
  });

  it("enum: an accepted value missing from the database is caught (this is the exact class of defect Stage 4 and Stage 5 each found for real)", () => {
    const expected: ExpectedEnum[] = [{ enumName: "payment_attempt_status", values: ["pending", "succeeded", "refund_reversed", "refund_failed"] }];
    const actual = [{ enumName: "payment_attempt_status", values: ["pending", "succeeded"] }];
    const { missingInDb, extraInDb } = compareEnumsBidirectional(expected, actual);
    expect(missingInDb).toEqual(["payment_attempt_status.refund_reversed", "payment_attempt_status.refund_failed"]);
    expect(extraInDb).toEqual([]);
  });

  it("enum: a legacy DB-only value not accepted by the application schema is reported as extra, not a failure by itself", () => {
    const expected: ExpectedEnum[] = [{ enumName: "payment_attempt_status", values: ["pending"] }];
    const actual = [{ enumName: "payment_attempt_status", values: ["pending", "some_legacy_value"] }];
    const { missingInDb, extraInDb } = compareEnumsBidirectional(expected, actual);
    expect(missingInDb).toEqual([]);
    expect(extraInDb).toEqual(["payment_attempt_status.some_legacy_value"]);
  });
});
