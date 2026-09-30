/**
 * Stage 5 (Database and Migration Readiness) — pure, DB-independent comparison logic for the
 * schema-parity checklist. Extracted into its own module (rather than living inline in the
 * postgres-backed test) so the exact same comparison functions can be:
 *   (a) run against a real, migration-built PostgreSQL (src/db/schemaParity.postgres.test.ts), and
 *   (b) fed deliberately-corrupted fixtures in a plain, non-Postgres unit test
 *       (src/db/schemaParityComparators.self-validation.test.ts) to PROVE the comparison logic
 *       actually fails when a contract is violated — not merely that it passes on a correct schema.
 *
 * Every comparator returns match/mismatch data with explicit counts, never a bare boolean, so the
 * caller can assert non-vacuous completeness (expected count > 0, unmatched count === 0) rather
 * than trusting an empty-looking diff to mean "verified."
 */
import { is, type SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core/columns/enum";

const dialect = new PgDialect();

// ---------------------------------------------------------------------------------------------
// Expected-set derivation (from the accepted application schema — never a hand-maintained list).
// ---------------------------------------------------------------------------------------------

export interface ExpectedColumn {
  table: string;
  column: string;
  sqlType: string;
  notNull: boolean;
}

export interface ExpectedPrimaryKey {
  table: string;
  columns: string[]; // ordered
}

export interface ExpectedForeignKey {
  table: string;
  columns: string[]; // ordered
  foreignTable: string;
  foreignColumns: string[]; // ordered
}

export interface IndexKey {
  kind: "column" | "expression";
  value: string; // plain column name for kind="column"; rendered expression text for kind="expression"
}

export interface ExpectedIndex {
  name: string;
  table: string;
  keys: IndexKey[]; // ordered, uniqueness-key positions only (never INCLUDE columns)
  includeColumns: string[]; // always [] today — drizzle-orm's index builder has no .include()
  // support in this repository's version (confirmed via grep against node_modules at authoring
  // time), and the schema uses none. Modeled explicitly, not omitted, so a real INCLUDE column
  // appearing on the database side is compared against a real (empty) expectation rather than
  // silently going unchecked.
  unique: boolean;
  predicateSql: string | null; // normalized, or null if not a partial index
}

export interface ExpectedEnum {
  enumName: string;
  values: string[];
}

export interface ExpectedSchema {
  tableNames: string[];
  columns: ExpectedColumn[];
  primaryKeys: ExpectedPrimaryKey[];
  foreignKeys: ExpectedForeignKey[];
  indexes: ExpectedIndex[]; // includes unique indexes — this schema has zero table-level
  // UNIQUE constraints (confirmed via repository-wide grep: every uniqueness contract is
  // authored via drizzle's uniqueIndex(), never unique()), so "unique constraint" and "unique
  // index" are the same category here. If a future schema change introduces a table-level
  // unique() constraint, config.uniqueConstraints will become non-empty and this derivation
  // must be extended — deriveExpectedSchema below asserts that array is still empty so that
  // change cannot silently go unverified.
  enums: ExpectedEnum[];
  enableRlsTables: string[];
}

function normalizePredicateSql(raw: string): string {
  // Explicit, narrow normalization rules (documented, not generic "close enough" matching), each
  // verified empirically against a real migrated database during this Stage's own remediation
  // (docs/remediation/stage5-evidence/index-predicate-normalization-probe.txt):
  // 1. Drizzle's PgDialect renders predicates fully table-qualified and quoted, e.g.
  //    `"business_staff_member"."removed_at" IS NULL`; PostgreSQL's own pg_get_expr() renders
  //    the same stored predicate unqualified and unquoted, e.g. `(removed_at IS NULL)`.
  //    Strip the `"table".` qualification prefix and all double-quotes.
  // 2. PostgreSQL's pg_get_expr() adds an explicit type cast to every literal it reconstructs
  //    from a stored parse tree once that literal is compared against a custom enum column,
  //    e.g. `status = 'pending'::staff_invitation_status` — drizzle's own rendering never emits
  //    this cast (`status = 'pending'`), since it never round-trips through a stored, detyped
  //    parse tree. Strip any `::identifier` type-cast suffix. (This is the identical class of
  //    normalization already required for column DEFAULT comparison earlier in this Stage.)
  // 3. Strip all parentheses. Safe only because every partial-index predicate in this schema
  //    is confirmed (via repository-wide grep for `.where(`) to be a single simple comparison
  //    (`col IS NULL` / `col IS NOT NULL` / `col = 'literal'`) with no AND/OR/nesting — so
  //    parentheses carry no grouping semantics to lose. A future compound predicate would need
  //    a different, precedence-aware normalization; this rule must not be reused for one.
  // 4. Collapse whitespace and trim.
  return raw
    .replace(/"[a-zA-Z0-9_]+"\./g, "")
    .replace(/"/g, "")
    .replace(/::[a-zA-Z_][a-zA-Z0-9_]*/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function derivePredicateSql(where: SQL): string {
  const { sql: text } = dialect.sqlToQuery(where);
  return normalizePredicateSql(text);
}

export function deriveExpectedSchema(schemaModule: Record<string, unknown>): ExpectedSchema {
  const tables: PgTable[] = [];
  for (const value of Object.values(schemaModule)) {
    if (is(value, PgTable)) tables.push(value);
  }

  const enums: PgEnum<[string, ...string[]]>[] = [];
  for (const value of Object.values(schemaModule)) {
    if (isPgEnum(value)) enums.push(value);
  }

  const columns: ExpectedColumn[] = [];
  const primaryKeys: ExpectedPrimaryKey[] = [];
  const foreignKeys: ExpectedForeignKey[] = [];
  const indexes: ExpectedIndex[] = [];
  const enableRlsTables: string[] = [];
  const tableNames: string[] = [];

  for (const table of tables) {
    const config = getTableConfig(table);
    tableNames.push(config.name);

    for (const column of config.columns) {
      columns.push({ table: config.name, column: column.name, sqlType: column.getSQLType(), notNull: column.notNull });
    }

    for (const pk of config.primaryKeys) {
      // Explicit, composite primary keys authored via the table's `(table) => [primaryKey(...)]`
      // callback form.
      primaryKeys.push({ table: config.name, columns: pk.columns.map((c) => c.name) });
    }
    const inlinePrimaryKeyColumns = config.columns.filter((c) => c.primary);
    if (inlinePrimaryKeyColumns.length > 0) {
      // Single-column primary keys authored inline on the column itself (`.primaryKey()`) — this
      // repository's exclusive PK style (confirmed empirically: config.primaryKeys was found
      // empty for every one of this schema's 74 tables the first time this derivation ran,
      // which is what originally surfaced this gap during this Stage's own remediation).
      // getTableConfig() does not surface these under config.primaryKeys at all; they must be
      // read from each column's own `.primary` flag.
      primaryKeys.push({ table: config.name, columns: inlinePrimaryKeyColumns.map((c) => c.name) });
    }

    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      foreignKeys.push({
        table: config.name,
        columns: ref.columns.map((c) => c.name),
        foreignTable: getTableConfig(ref.foreignTable).name,
        foreignColumns: ref.foreignColumns.map((c) => c.name),
      });
    }

    if (config.uniqueConstraints.length > 0) {
      // See the ExpectedSchema.indexes doc comment — this repository has none today. If this
      // fires, deriveExpectedSchema must be extended to derive them as their own category
      // rather than silently omitting a real, accepted uniqueness contract.
      throw new Error(
        `Table "${config.name}" defines ${config.uniqueConstraints.length} table-level unique constraint(s) via unique() — ` +
          `deriveExpectedSchema assumed this repository has none (verified via grep at authoring time) and does not yet derive them. Extend deriveExpectedSchema before proceeding.`,
      );
    }

    for (const idx of config.indexes) {
      const name = idx.config.name;
      if (!name) {
        throw new Error(`Table "${config.name}" defines an unnamed index — every accepted index in this schema must be named.`);
      }
      const keys: IndexKey[] = [];
      for (const col of idx.config.columns) {
        if (!("name" in col) || typeof col.name !== "string") {
          // The accepted application schema does not currently author expression indexes
          // (confirmed via repository-wide grep at authoring time). Per this order's own
          // Section 5 policy, an accepted expression index would need to be modeled as a real
          // kind="expression" expectation, not silently coerced into a column — since none
          // exist today, this stays a hard stop rather than a guess at what the expression's
          // rendered text should be compared against.
          throw new Error(`Index "${name}" on "${config.name}" has a non-plain-column (expression) member — expected zero expression indexes in the accepted application schema (verified via grep at authoring time). Extend deriveExpectedSchema before proceeding.`);
        }
        keys.push({ kind: "column", value: col.name });
      }
      indexes.push({
        name,
        table: config.name,
        keys,
        includeColumns: [], // see ExpectedIndex.includeColumns doc comment.
        unique: idx.config.unique,
        predicateSql: idx.config.where ? derivePredicateSql(idx.config.where) : null,
      });
    }

    if (config.enableRLS) enableRlsTables.push(config.name);
  }

  return {
    tableNames,
    columns,
    primaryKeys,
    foreignKeys,
    indexes,
    enums: enums.map((e) => ({ enumName: e.enumName, values: [...e.enumValues] })),
    enableRlsTables,
  };
}

// ---------------------------------------------------------------------------------------------
// Comparators. Every function returns explicit counts — never a bare pass/fail boolean — so
// completeness (expected > 0, unmatched === 0) can be asserted by the caller, not assumed.
// ---------------------------------------------------------------------------------------------

export interface ComparisonResult {
  expectedCount: number;
  matchedCount: number;
  unmatchedExpected: string[];
  unexpectedActual: string[];
}

export function compareNameSets(expected: string[], actual: string[]): ComparisonResult {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unmatchedExpected = expected.filter((e) => !actualSet.has(e));
  const unexpectedActual = actual.filter((a) => !expectedSet.has(a));
  return {
    expectedCount: expected.length,
    matchedCount: expected.length - unmatchedExpected.length,
    unmatchedExpected,
    unexpectedActual,
  };
}

// PostgreSQL's serial/bigserial/smallserial are not real stored types — they are pure DDL sugar
// for "integer/bigint/smallint NOT NULL DEFAULT nextval(...)". Once created, the column's actual
// pg_type is always the underlying integer type; format_type() can never report "bigserial",
// only "bigint" — confirmed empirically during this Stage's own remediation (audit_event.id:
// drizzle getSQLType()="bigserial", real database format_type()="bigint"). This is a documented
// PostgreSQL semantic, not an invented equivalence: the sequence/default this sugar also creates
// is a separate, correct part of the column's contract, not part of its TYPE, and is out of this
// comparator's scope (defaults are not compared here).
const SERIAL_TO_BASE_TYPE: Record<string, string> = {
  serial: "integer",
  bigserial: "bigint",
  smallserial: "smallint",
};

export function normalizeTypeString(raw: string): string {
  // Explicit, documented rules only — never generic "close enough" matching:
  // 1. Comma-spacing: PostgreSQL's format_type() renders precision/scale parameters without a
  //    space after the comma (`numeric(5,2)`); drizzle-orm's getSQLType() renders them with one
  //    (`numeric(5, 2)`) — confirmed empirically against this schema's one
  //    numeric(precision,scale) column (beneficial_owner.ownership_percent).
  // 2. serial/bigserial/smallserial DDL-sugar resolution — see SERIAL_TO_BASE_TYPE above.
  const commaNormalized = raw.replace(/,\s+/g, ",");
  return SERIAL_TO_BASE_TYPE[commaNormalized] ?? commaNormalized;
}

export interface ActualColumnType {
  key: string; // "table.column"
  pgType: string;
}

export function compareColumnTypes(expected: ExpectedColumn[], actual: ActualColumnType[]): { mismatches: string[]; comparedCount: number } {
  const actualMap = new Map(actual.map((a) => [a.key, a.pgType]));
  const mismatches: string[] = [];
  let comparedCount = 0;
  for (const col of expected) {
    const key = `${col.table}.${col.column}`;
    const actualType = actualMap.get(key);
    if (actualType === undefined) continue; // presence is a separate, already-asserted category.
    comparedCount += 1;
    if (normalizeTypeString(actualType) !== normalizeTypeString(col.sqlType)) {
      mismatches.push(`${key}: expected="${col.sqlType}" actual="${actualType}"`);
    }
  }
  return { mismatches, comparedCount };
}

export interface ActualColumnNullability {
  key: string;
  nullable: boolean;
}

export function compareNullability(expected: ExpectedColumn[], actual: ActualColumnNullability[]): { mismatches: string[]; comparedCount: number } {
  const actualMap = new Map(actual.map((a) => [a.key, a.nullable]));
  const mismatches: string[] = [];
  let comparedCount = 0;
  for (const col of expected) {
    const key = `${col.table}.${col.column}`;
    const actualNullable = actualMap.get(key);
    if (actualNullable === undefined) continue;
    comparedCount += 1;
    const expectedNullable = !col.notNull;
    if (actualNullable !== expectedNullable) {
      mismatches.push(`${key}: expected.notNull=${col.notNull} actual.is_nullable=${actualNullable}`);
    }
  }
  return { mismatches, comparedCount };
}

export interface ActualPrimaryKey {
  table: string;
  columns: string[]; // ordered by ordinal position
}

export function comparePrimaryKeys(expected: ExpectedPrimaryKey[], actual: ActualPrimaryKey[]): { mismatches: string[]; expectedCount: number } {
  const actualMap = new Map(actual.map((a) => [a.table, a.columns]));
  const mismatches: string[] = [];
  for (const pk of expected) {
    const actualCols = actualMap.get(pk.table);
    if (actualCols === undefined) {
      mismatches.push(`${pk.table}: expected PK columns [${pk.columns.join(",")}] but table has no PK in the database`);
      continue;
    }
    if (actualCols.length !== pk.columns.length || !actualCols.every((c, i) => c === pk.columns[i])) {
      mismatches.push(`${pk.table}: expected PK columns [${pk.columns.join(",")}] (ordered) but database has [${actualCols.join(",")}]`);
    }
  }
  return { mismatches, expectedCount: expected.length };
}

function fkKey(fk: { table: string; columns: string[]; foreignTable: string; foreignColumns: string[] }): string {
  return `${fk.table}(${fk.columns.join(",")})->${fk.foreignTable}(${fk.foreignColumns.join(",")})`;
}

export function compareForeignKeys(expected: ExpectedForeignKey[], actual: ExpectedForeignKey[]): ComparisonResult {
  return compareNameSets(expected.map(fkKey), actual.map(fkKey));
}

export interface ActualIndex {
  name: string;
  table: string;
  keys: IndexKey[]; // ordered, positions where ordinal <= pg_index.indnkeyatts only
  includeColumns: string[]; // positions where ordinal > indnkeyatts — never keys, never expressions
  unique: boolean;
  predicateSql: string | null; // already normalized the same way as ExpectedIndex.predicateSql
  extractedKeyCount: number; // keys.length, redundant on purpose — see compareIndexesSemantic's
  // own key-slot completeness assertion, which exists specifically to catch a regression where
  // keys.length silently diverges from what the database's own indnkeyatts says it should be
  // (the exact class of bug — a catalog join silently dropping a position — this whole
  // remediation order exists to close).
  indnkeyatts: number;
}

function keyToString(k: IndexKey): string {
  return `${k.kind}:${k.value}`;
}

export function compareIndexesSemantic(expected: ExpectedIndex[], actual: ActualIndex[]): { mismatches: string[]; missingNames: string[]; expectedCount: number; keySlotCompletenessFailures: string[] } {
  // Part I Step 9 of the Zero-False-Positive order: prove no index key slot can silently
  // disappear during extraction. This is checked against EVERY actual index the database
  // returned, independent of whether that index is even in the expected set — a real,
  // structural self-check on the extraction itself, not a comparison against drizzle.
  const keySlotCompletenessFailures: string[] = [];
  for (const a of actual) {
    if (a.extractedKeyCount !== a.indnkeyatts) {
      keySlotCompletenessFailures.push(`${a.name}: extracted ${a.extractedKeyCount} key(s) but pg_index.indnkeyatts=${a.indnkeyatts}`);
    }
  }

  const actualByName = new Map(actual.map((a) => [a.name, a]));
  const mismatches: string[] = [];
  const missingNames: string[] = [];
  for (const idx of expected) {
    const found = actualByName.get(idx.name);
    if (!found) {
      missingNames.push(idx.name);
      continue;
    }
    const diffs: string[] = [];
    if (found.table !== idx.table) diffs.push(`table: expected=${idx.table} actual=${found.table}`);
    const expectedKeyStrs = idx.keys.map(keyToString);
    const actualKeyStrs = found.keys.map(keyToString);
    if (expectedKeyStrs.length !== actualKeyStrs.length || !expectedKeyStrs.every((k, i) => k === actualKeyStrs[i])) {
      diffs.push(`keys: expected=[${expectedKeyStrs.join(",")}] actual=[${actualKeyStrs.join(",")}]`);
    }
    if (idx.includeColumns.length > 0 || found.includeColumns.length > 0) {
      const expectedIncludeSet = new Set(idx.includeColumns);
      const actualIncludeSet = new Set(found.includeColumns);
      const sameSet = expectedIncludeSet.size === actualIncludeSet.size && [...expectedIncludeSet].every((c) => actualIncludeSet.has(c));
      if (!sameSet) diffs.push(`includeColumns: expected=[${idx.includeColumns.join(",")}] actual=[${found.includeColumns.join(",")}]`);
    }
    if (found.unique !== idx.unique) diffs.push(`unique: expected=${idx.unique} actual=${found.unique}`);
    const expectedPredicate = idx.predicateSql ?? null;
    const actualPredicate = found.predicateSql ?? null;
    if (expectedPredicate !== actualPredicate) diffs.push(`predicate: expected=${JSON.stringify(expectedPredicate)} actual=${JSON.stringify(actualPredicate)}`);
    if (diffs.length > 0) mismatches.push(`${idx.name}: ${diffs.join("; ")}`);
  }
  return { mismatches, missingNames, expectedCount: expected.length, keySlotCompletenessFailures };
}

export interface ActualEnum {
  enumName: string;
  values: string[];
}

export function compareEnumsBidirectional(expected: ExpectedEnum[], actual: ActualEnum[]): {
  missingInDb: string[];
  extraInDb: string[];
  expectedEnumCount: number;
} {
  const actualMap = new Map(actual.map((a) => [a.enumName, a.values]));
  const missingInDb: string[] = [];
  const extraInDb: string[] = [];
  for (const e of expected) {
    const actualValues = actualMap.get(e.enumName) ?? [];
    for (const v of e.values) {
      if (!actualValues.includes(v)) missingInDb.push(`${e.enumName}.${v}`);
    }
    for (const v of actualValues) {
      if (!e.values.includes(v)) extraInDb.push(`${e.enumName}.${v}`);
    }
  }
  return { missingInDb, extraInDb, expectedEnumCount: expected.length };
}
