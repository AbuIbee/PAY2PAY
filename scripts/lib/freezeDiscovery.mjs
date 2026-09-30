import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Stage 5 authoritative source-freeze — changed-path discovery.
 *
 * Replaces a prior implementation that parsed `git status --porcelain=v1` as human-readable text:
 * it ran `.trim()` on the ENTIRE multi-line status blob (not per line) before slicing each line's
 * fixed 3-character status prefix. Whenever the very FIRST line of that blob happened to begin
 * with a leading space (an ordinary "unstaged, modified" entry, e.g. " M .github/workflows/ci.yml"),
 * the blob-level `.trim()` stripped that one leading space, shifting the fixed-width parse for
 * that single line by one character and truncating its leading dot — "github/workflows/ci.yml",
 * a path that does not exist, silently absent from every downstream hash/coverage check.
 *
 * This module never parses a human-readable status line. It uses Git's own NUL-delimited,
 * machine-readable output exclusively:
 *   - `git diff --name-only -z HEAD --` for tracked files changed relative to HEAD (staged and
 *     unstaged).
 *   - `git ls-files --others --exclude-standard -z` for untracked, non-ignored files.
 * NUL-delimited output has no escaping, no quoting, no fixed-width prefix, and no whitespace
 * sensitivity to get wrong — a path is exactly the bytes between two NUL bytes, always.
 */

export function parseNulDelimited(raw) {
  if (!raw) return [];
  return raw.split("\0").filter((s) => s.length > 0);
}

export function gitTrackedChangedPaths(repoRoot) {
  const r = spawnSync("git", ["diff", "--name-only", "-z", "HEAD", "--"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git diff --name-only -z HEAD -- failed (exit ${r.status}): ${r.stderr}`);
  return { paths: parseNulDelimited(r.stdout), rawStdout: r.stdout, stderr: r.stderr };
}

export function gitUntrackedPaths(repoRoot) {
  const r = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ls-files --others --exclude-standard -z failed (exit ${r.status}): ${r.stderr}`);
  return { paths: parseNulDelimited(r.stdout), rawStdout: r.stdout, stderr: r.stderr };
}

export function unionPaths(a, b) {
  return [...new Set([...a, ...b])].sort();
}

/**
 * Classifies exactly one repository-relative path (never touches any path other than the one
 * given — never lists a directory, never globs). Returns an existence/content record; never
 * throws and never silently omits a path just because it does not currently exist on disk (a
 * changed path Git reports can legitimately be a deletion).
 */
export function classifyEntry(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!existsSync(abs)) {
    return { path: relPath, exists: false, state: "deleted", sha256: null, size: null };
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    // Neither `git diff --name-only` nor `git ls-files` ever reports a bare directory, but this
    // is a hard-fail guard rather than a silent skip if that assumption is ever violated.
    return { path: relPath, exists: true, state: `non-file:${st.isDirectory() ? "directory" : "other"}`, sha256: null, size: null };
  }
  const buf = readFileSync(abs);
  return { path: relPath, exists: true, state: "file", sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length };
}

/**
 * Derives the complete changed-path set (tracked-vs-HEAD union untracked-non-ignored) and
 * classifies every single one, by mapping directly over that exact array — never re-deriving or
 * re-parsing a separate representation for the entries themselves, so entry-count and
 * changed-path-count are equal BY CONSTRUCTION, not merely by later comparison.
 */
export function deriveFullChangedFileFreeze(repoRoot) {
  const tracked = gitTrackedChangedPaths(repoRoot);
  const untracked = gitUntrackedPaths(repoRoot);
  const changedPaths = unionPaths(tracked.paths, untracked.paths);
  const entries = changedPaths.map((p) => classifyEntry(repoRoot, p));
  return { tracked, untracked, changedPaths, entries };
}
