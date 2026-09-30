import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { compareIndexesSemantic, derivePredicateSql, type ActualIndex, type ExpectedIndex } from "@/db/schemaParityComparators";

/**
 * Stage 5 Final Zero-False-Positive Index Parity Remediation Order, Part II Step 8: exercises the
 * REAL, corrected PostgreSQL catalog extraction (not just the pure comparator, which
 * `schemaParityComparators.self-validation.test.ts` already proves independently) against a
 * disposable, test-owned scratch table — never any accepted table — covering the four required
 * cases: an ordinary index, an index with an added expression key (the exact Codex-demonstrated
 * false-positive shape), an expression-only index, and an index with an INCLUDE column. The prior
 * extraction (INNER JOIN unnest(indkey) to pg_attribute) silently dropped every expression
 * position (attnum=0 matches no pg_attribute row) — this test proves the corrected extraction
 * (pg_get_indexdef(indexrelid, key_position, true), keyed off pg_index.indnkeyatts) does not.
 *
 * The scratch table/indexes are created and dropped inside this file only — no accepted table,
 * migration, or application schema object is touched.
 */

const SCRATCH_TABLE = "stage5_index_extraction_scratch";

interface RawIndexRow extends Record<string, unknown> {
  index_name: string;
  table_name: string;
  is_unique: boolean;
  key_count: number;
  total_count: number;
  predicate: string | null;
  positions: { ord: number; attnum: number; isKey: boolean; value: string }[];
}

async function extractActualIndex(indexName: string): Promise<ActualIndex> {
  const db = getDb();
  const rows = await db.execute<RawIndexRow>(
    sql`SELECT ic.relname AS index_name, tc.relname AS table_name, ix.indisunique AS is_unique,
               ix.indnkeyatts AS key_count, ix.indnatts AS total_count,
               pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
               (
                 SELECT jsonb_agg(jsonb_build_object(
                   'ord', k.ord, 'attnum', k.attnum, 'isKey', k.ord <= ix.indnkeyatts,
                   'value', pg_get_indexdef(ix.indexrelid, k.ord::int, true)
                 ) ORDER BY k.ord)
                 FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
               ) AS positions
        FROM pg_index ix
        JOIN pg_class ic ON ic.oid = ix.indexrelid
        JOIN pg_class tc ON tc.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = tc.relnamespace
        WHERE n.nspname = 'public' AND ic.relname = ${indexName}` as never,
  );
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  const keys: ActualIndex["keys"] = [];
  const includeColumns: string[] = [];
  for (const pos of row.positions) {
    if (pos.isKey) {
      keys.push({ kind: pos.attnum === 0 ? "expression" : "column", value: pos.value });
    } else {
      includeColumns.push(pos.value);
    }
  }
  return {
    name: row.index_name,
    table: row.table_name,
    keys,
    includeColumns,
    unique: row.is_unique,
    predicateSql: row.predicate ? derivePredicateSql(sql.raw(row.predicate)) : null,
    extractedKeyCount: keys.length,
    indnkeyatts: row.key_count,
  };
}

// The disposable harness's reduced-privilege runtime role (what getDb() connects as — see
// scripts/postgres-test-db.mjs, buildRuntimeRoleStatements) is deliberately never granted CREATE
// on schema public, by established Stage 3/4 design, unchanged here — so this file's own
// test-owned scratch DDL (create/drop a throwaway table+indexes, never touching the accepted
// schema) uses a SEPARATE bootstrap connection the harness exposes solely for this purpose
// (POSTGRES_TEST_BOOTSTRAP_DATABASE_URL). Every actual extraction QUERY below still goes through
// getDb() — the real, reduced-privilege runtime role every other test in this suite uses — since
// pg_catalog is world-readable regardless of table ownership.
function bootstrapSql() {
  const url = process.env.POSTGRES_TEST_BOOTSTRAP_DATABASE_URL;
  if (!url) throw new Error("POSTGRES_TEST_BOOTSTRAP_DATABASE_URL is required for this test's scratch-table DDL setup/teardown.");
  return postgres(url, { max: 1, prepare: false });
}

describe("Stage 5: real-PostgreSQL index catalog extraction (disposable scratch table, real database)", () => {
  beforeAll(async () => {
    const admin = bootstrapSql();
    try {
      await admin.unsafe(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
      await admin.unsafe(`CREATE TABLE ${SCRATCH_TABLE} (payment_attempt_id uuid, provider_name text, status text)`);
      await admin.unsafe(`CREATE UNIQUE INDEX case_a_ordinary ON ${SCRATCH_TABLE} (payment_attempt_id)`);
      await admin.unsafe(`CREATE UNIQUE INDEX case_b_mixed ON ${SCRATCH_TABLE} (payment_attempt_id, lower(provider_name))`);
      await admin.unsafe(`CREATE INDEX case_c_expr_only ON ${SCRATCH_TABLE} (lower(provider_name))`);
      await admin.unsafe(`CREATE UNIQUE INDEX case_d_include ON ${SCRATCH_TABLE} (payment_attempt_id) INCLUDE (provider_name)`);
      // The reduced-privilege runtime role only has SELECT/INSERT/UPDATE/DELETE granted on
      // tables that existed at harness-bootstrap time (and future ones via ALTER DEFAULT
      // PRIVILEGES for the same four) — this table is created after that bootstrap, so it needs
      // an explicit grant for getDb()'s own catalog-metadata queries below to even see it via
      // information_schema/pg_catalog under the normal ACL path (system catalogs are readable
      // regardless, but granting here keeps this test's own connection story unambiguous rather
      // than relying solely on catalog world-readability).
      await admin.unsafe(`GRANT SELECT ON ${SCRATCH_TABLE} TO pay2pay_test_runtime`);
    } finally {
      await admin.end({ timeout: 1 }).catch(() => {});
    }
  });

  afterAll(async () => {
    const admin = bootstrapSql();
    try {
      await admin.unsafe(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    } finally {
      await admin.end({ timeout: 1 }).catch(() => {});
    }
  });

  it("Case A — an ordinary single-column index extracts exactly one ordinary column key", async () => {
    const actual = await extractActualIndex("case_a_ordinary");
    expect(actual.keys).toEqual([{ kind: "column", value: "payment_attempt_id" }]);
    expect(actual.includeColumns).toEqual([]);
    expect(actual.extractedKeyCount).toBe(actual.indnkeyatts);
  });

  it("Case B — an index with an ADDED expression key extracts BOTH keys (the exact Codex-demonstrated shape) and is rejected as a mismatch against an accepted single-column index", async () => {
    const actual = await extractActualIndex("case_b_mixed");
    expect(actual.keys).toEqual([
      { kind: "column", value: "payment_attempt_id" },
      { kind: "expression", value: "lower(provider_name)" },
    ]);
    expect(actual.extractedKeyCount).toBe(actual.indnkeyatts);
    console.log("EXPRESSION KEY PRESERVATION: PASS");

    // Codex's exact demonstrated defect, reproduced against a real, migration-built PostgreSQL
    // catalog (not just an in-memory fixture — schemaParityComparators.self-validation.test.ts
    // proves the pure-comparator side of this same case).
    const acceptedSingleColumn: ExpectedIndex = {
      name: "case_b_mixed",
      table: SCRATCH_TABLE,
      keys: [{ kind: "column", value: "payment_attempt_id" }],
      includeColumns: [],
      unique: true,
      predicateSql: null,
    };
    const { mismatches } = compareIndexesSemantic([acceptedSingleColumn], [actual]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("keys:");
    console.log("CODEX FALSE-POSITIVE REGRESSION: REJECTED AS EXPECTED");
  });

  it("Case C — an expression-only index extracts exactly one expression key, never zero", async () => {
    const actual = await extractActualIndex("case_c_expr_only");
    expect(actual.keys).toEqual([{ kind: "expression", value: "lower(provider_name)" }]);
    expect(actual.keys.length).toBeGreaterThan(0);
    expect(actual.extractedKeyCount).toBe(actual.indnkeyatts);
  });

  it("Case D — an INCLUDE column is extracted separately from the uniqueness key, never counted as a second key", async () => {
    const actual = await extractActualIndex("case_d_include");
    expect(actual.keys).toEqual([{ kind: "column", value: "payment_attempt_id" }]);
    expect(actual.includeColumns).toEqual(["provider_name"]);
    expect(actual.indnkeyatts).toBe(1); // exactly one KEY attribute...
    expect(actual.extractedKeyCount).toBe(1);
    console.log("INCLUDE COLUMN SEPARATION: PASS");
  });

  it("key-slot completeness holds for every case above (extracted_key_count == pg_index.indnkeyatts)", async () => {
    const names = ["case_a_ordinary", "case_b_mixed", "case_c_expr_only", "case_d_include"];
    const actuals = await Promise.all(names.map(extractActualIndex));
    const { keySlotCompletenessFailures } = compareIndexesSemantic([], actuals);
    expect(keySlotCompletenessFailures).toEqual([]);
    console.log("INDEX EXTRACTION KEY-SLOT COMPLETENESS: PASS");
  });
});
