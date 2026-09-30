import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyEntry, parseNulDelimited, unionPaths } from "./lib/freezeDiscovery.mjs";

/**
 * Stage 5 authoritative source-freeze — harness self-test only (RULE 8). Exercises the exact
 * defect class the "FINAL SOURCE-FREEZE HARNESS CORRECTION" order requires proof against: leading
 * dots, embedded whitespace, deletion, and untracked-file inclusion, using synthetic NUL-delimited
 * strings and a disposable scratch directory — never the real repository's own files, never
 * product behavior.
 */

test("parseNulDelimited preserves a leading-dot path exactly (the defect this order names)", () => {
  const raw = ".github/workflows/ci.yml\0.gitignore\0src/lib/ordinary.ts\0";
  const paths = parseNulDelimited(raw);
  assert.deepEqual(paths, [".github/workflows/ci.yml", ".gitignore", "src/lib/ordinary.ts"]);
  assert.equal(paths[0][0], ".", "leading dot must survive — this is the exact byte a fixed-width-slice parse previously ate");
});

test("parseNulDelimited preserves embedded whitespace in a filename exactly", () => {
  const raw = "src/lib/a file with spaces.ts\0";
  const paths = parseNulDelimited(raw);
  assert.deepEqual(paths, ["src/lib/a file with spaces.ts"]);
});

test("parseNulDelimited returns an empty array for empty/whitespace-only input, never a bogus single entry", () => {
  assert.deepEqual(parseNulDelimited(""), []);
  assert.deepEqual(parseNulDelimited(null), []);
  assert.deepEqual(parseNulDelimited(undefined), []);
});

test("unionPaths includes a path present ONLY in the untracked set (proves untracked files are never omitted)", () => {
  const tracked = [".github/workflows/ci.yml", "src/lib/ordinary.ts"];
  const untracked = ["docs/remediation/new-untracked-report.md"];
  const union = unionPaths(tracked, untracked);
  assert.ok(union.includes("docs/remediation/new-untracked-report.md"), "an untracked-only path must appear in the union");
  assert.ok(union.includes(".github/workflows/ci.yml"), "a tracked-only path must appear in the union");
  assert.equal(new Set(union).size, union.length, "union must be duplicate-free");
});

test("classifyEntry: an ordinary nested file that exists is hashed and marked exists:true", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stage5-freeze-test-"));
  try {
    const nestedDir = path.join(dir, "nested", "path");
    mkdirSync(nestedDir, { recursive: true });
    const relPath = "nested/path/ordinary.ts";
    writeFileSync(path.join(dir, relPath), "export const x = 1;\n");
    const entry = classifyEntry(dir, relPath);
    assert.equal(entry.exists, true);
    assert.equal(entry.path, relPath);
    assert.equal(typeof entry.sha256, "string");
    assert.equal(entry.sha256.length, 64);
    assert.ok(entry.size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyEntry: a path with a leading dot and a path with embedded spaces are both classified correctly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stage5-freeze-test-"));
  try {
    mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
    writeFileSync(path.join(dir, "a file with spaces.txt"), "hello\n");

    const dotEntry = classifyEntry(dir, ".github/workflows/ci.yml");
    assert.equal(dotEntry.exists, true);
    assert.equal(dotEntry.path, ".github/workflows/ci.yml");
    assert.equal(dotEntry.path[0], ".");

    const spaceEntry = classifyEntry(dir, "a file with spaces.txt");
    assert.equal(spaceEntry.exists, true);
    assert.equal(spaceEntry.path, "a file with spaces.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyEntry: a changed path that no longer exists on disk is represented as deleted, never silently skipped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stage5-freeze-test-"));
  try {
    const relPath = "src/lib/will-be-deleted.ts";
    mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    const abs = path.join(dir, relPath);
    writeFileSync(abs, "export const y = 2;\n");
    unlinkSync(abs); // simulates a changed path that Git reports (a deletion) but no longer exists.

    const entry = classifyEntry(dir, relPath);
    assert.equal(entry.exists, false);
    assert.equal(entry.state, "deleted");
    assert.equal(entry.sha256, null);
    assert.equal(entry.path, relPath, "the path itself must still be reported — never dropped from the result set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
