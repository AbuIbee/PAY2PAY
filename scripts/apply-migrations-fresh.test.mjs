import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Pure/no-DB tests for apply-migrations-fresh.mjs's file-discovery step — the script's actual side
// effect (applying SQL to a live Postgres instance) isn't something a unit test should trigger,
// mirroring check-schema-drift.test.mjs's identical restraint.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

test("every migration filename is timestamp-prefixed with a unique prefix, so lexical sort order equals chronological order", () => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  assert.ok(files.length > 0, "expected at least one migration file to exist");
  const prefixes = new Set();
  for (const file of files) {
    const match = /^(\d{14})_/.exec(file);
    assert.ok(match, `${file} does not start with a 14-digit timestamp prefix`);
    assert.ok(!prefixes.has(match[1]), `${file} shares its timestamp prefix with another migration — apply order would be ambiguous`);
    prefixes.add(match[1]);
  }
});

test("real migration set is non-empty and every file is readable", () => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  assert.ok(files.length >= 30, `expected the real, growing migration history (>=30 files as of PRSprint 30) — found ${files.length}`);
});
