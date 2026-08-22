import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findDestructivePatterns, migrationsDir, KNOWN_HISTORICAL_EXCEPTIONS } from "./check-migration-safety.mjs";

test("flags DROP TABLE, DROP COLUMN, TRUNCATE, DELETE FROM, RENAME, and lossy ALTER COLUMN TYPE", () => {
  assert.deepEqual(findDestructivePatterns('DROP TABLE "foo";'), ["DROP TABLE"]);
  assert.deepEqual(findDestructivePatterns('ALTER TABLE "foo" DROP COLUMN "bar";'), ["DROP COLUMN"]);
  assert.deepEqual(findDestructivePatterns("TRUNCATE foo;"), ["TRUNCATE"]);
  assert.deepEqual(findDestructivePatterns("DELETE FROM foo WHERE 1=1;"), ["DELETE FROM"]);
  assert.deepEqual(findDestructivePatterns('ALTER TABLE "foo" RENAME TO "bar";'), ["RENAME TO"]);
  assert.deepEqual(findDestructivePatterns('ALTER TABLE "foo" RENAME COLUMN "a" TO "b";'), ["RENAME COLUMN"]);
  assert.deepEqual(findDestructivePatterns('ALTER TABLE "foo" ALTER COLUMN "bar" TYPE integer;'), [
    "ALTER COLUMN ... TYPE (potentially lossy type change)",
  ]);
});

test("does not flag additive statements (the normal case for every migration in this repo)", () => {
  const additive = `
    CREATE TABLE "foo" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "name" text NOT NULL
    );--> statement-breakpoint
    ALTER TABLE "foo" ADD COLUMN "email" text;--> statement-breakpoint
    CREATE INDEX "foo_name_idx" ON "foo" ("name");--> statement-breakpoint
    ALTER TABLE "foo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
    REVOKE ALL ON "foo" FROM anon, authenticated;
  `;
  assert.deepEqual(findDestructivePatterns(additive), []);
});

test("does not false-positive on the word 'type' or 'drop' appearing outside a destructive keyword pair", () => {
  // Column/type names and comments that merely contain these words must not trigger — only the
  // specific multi-word destructive phrases should.
  assert.deepEqual(findDestructivePatterns('CREATE TABLE "card_type" ("id" uuid PRIMARY KEY);'), []);
  assert.deepEqual(findDestructivePatterns("-- this comment mentions a drop-down menu, not SQL DROP"), []);
});

test("every real migration file is either free of destructive statements, or explicitly listed in KNOWN_HISTORICAL_EXCEPTIONS with no unreviewed new exceptions", () => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const unexpectedlyDestructive = [];
  for (const file of files) {
    if (KNOWN_HISTORICAL_EXCEPTIONS.has(file)) continue;
    const text = readFileSync(path.join(migrationsDir, file), "utf8");
    const found = findDestructivePatterns(text);
    if (found.length > 0) unexpectedlyDestructive.push(`${file}: ${found.join(", ")}`);
  }
  assert.deepEqual(unexpectedlyDestructive, [], "found destructive statement(s) not covered by a reviewed historical exception");
});

test("every KNOWN_HISTORICAL_EXCEPTIONS entry still exists as a real migration file (no stale/typo'd exception)", () => {
  const files = new Set(readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")));
  for (const exception of KNOWN_HISTORICAL_EXCEPTIONS) {
    assert.ok(files.has(exception), `${exception} is listed as an exception but no longer exists in ${migrationsDir}`);
  }
});
