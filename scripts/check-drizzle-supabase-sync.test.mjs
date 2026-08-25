import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { extractCreatedTables, findMissingTables, drizzleMigrationsDir, supabaseMigrationsDir } from "./check-drizzle-supabase-sync.mjs";

test("extractCreatedTables finds every CREATE TABLE name in a migration file's SQL", () => {
  const sql = `
    CREATE TYPE "public"."foo_status" AS ENUM('a', 'b');--> statement-breakpoint
    CREATE TABLE "foo" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
    );--> statement-breakpoint
    CREATE TABLE "bar" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
    );
  `;
  assert.deepEqual(extractCreatedTables(sql), new Set(["foo", "bar"]));
});

test("extractCreatedTables returns an empty set for a migration with no CREATE TABLE (e.g. an ALTER-only file)", () => {
  const sql = `ALTER TABLE "foo" ADD COLUMN "email" text;`;
  assert.deepEqual(extractCreatedTables(sql), new Set());
});

test("findMissingTables reports drizzle tables absent from the supabase set — the exact PRSprint 10 agreement_invitation defect", () => {
  const drizzleTables = new Set(["agreement", "agreement_invitation", "user_account"]);
  const supabaseTables = new Set(["agreement", "user_account"]);
  assert.deepEqual(findMissingTables(drizzleTables, supabaseTables), ["agreement_invitation"]);
});

test("findMissingTables reports nothing when every drizzle table is mirrored", () => {
  const tables = new Set(["agreement", "user_account"]);
  assert.deepEqual(findMissingTables(tables, tables), []);
});

test("findMissingTables never flags a table that exists only in supabase/migrations/ (e.g. a hand-added, non-drizzle-generated table)", () => {
  const drizzleTables = new Set(["agreement"]);
  const supabaseTables = new Set(["agreement", "some_manual_supabase_only_table"]);
  assert.deepEqual(findMissingTables(drizzleTables, supabaseTables), []);
});

test("the real repo: every table drizzle/migrations/ has ever created exists in supabase/migrations/ (regression guard for the exact PRSprint 10 agreement_invitation defect)", () => {
  function collectTables(dir) {
    const names = new Set();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".sql")) continue;
      for (const name of extractCreatedTables(readFileSync(path.join(dir, file), "utf8"))) names.add(name);
    }
    return names;
  }
  const drizzleTables = collectTables(drizzleMigrationsDir);
  const supabaseTables = collectTables(supabaseMigrationsDir);
  assert.deepEqual(findMissingTables(drizzleTables, supabaseTables), []);
});
