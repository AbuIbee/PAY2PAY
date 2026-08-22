#!/usr/bin/env node
/**
 * PRSprint 30 (docs/prsprints/PRSPRINT_30_CI_CD_DEPLOYMENT_GATES_SCHEMA_DRIFT_PREVENTION.md), master-
 * spec item 128: "Avoid destructive migrations during active deployment — prefer: add new column/
 * table; deploy code using it; migrate data; remove old structure later." Every migration in this
 * repo's history has in fact been additive-only (docs/OPERATIONS_BACKUP_RECOVERY.md's own rollback
 * strategy depends on that being true — "the practical rollback strategy for a bad migration is
 * forward-fix, not down-migration"). This script makes that an enforced CI gate, not just a
 * convention: it fails if any migration file contains a genuinely destructive statement, unless the
 * file is explicitly listed in KNOWN_HISTORICAL_EXCEPTIONS below.
 *
 * Pure static text scanning — no database connection, no external credentials, runs on every push/PR.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

/**
 * Pre-PRSprint-30 migrations, already applied to production, reviewed and accepted at the time —
 * this check is not retroactive. Never add to this list for a *new* migration; the whole point is
 * that a new destructive change should be a deliberate, escalated decision, not a silent default.
 * (`docs/OPERATIONS_BACKUP_RECOVERY.md`: "A migration that ever needs to be genuinely destructive
 * ... requires special handling" — that handling is Product Owner sign-off, not adding a filename
 * here.)
 */
export const KNOWN_HISTORICAL_EXCEPTIONS = new Set([
  // Sprint 3: dropped a Phase-0 placeholder column, superseded by identity_verification_record
  // before any production data ever depended on it. See personalProfile schema's own doc comment.
  "20260811130300_sprint3_drop_placeholder_verification_tier.sql",
]);

/**
 * Deliberately pattern-based, not a full SQL parser — false positives are cheap (an author adds the
 * file to KNOWN_HISTORICAL_EXCEPTIONS-equivalent escalation, i.e. gets Product Owner sign-off and the
 * file is added to the exceptions list with a reason); false negatives (a destructive statement this
 * misses) are the real risk this exists to minimize, so patterns are intentionally broad.
 */
const DESTRUCTIVE_PATTERNS = [
  { name: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { name: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  { name: "DROP TYPE", pattern: /\bDROP\s+TYPE\b/i },
  { name: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { name: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/i },
  { name: "RENAME TO", pattern: /\bRENAME\s+TO\b/i },
  { name: "RENAME COLUMN", pattern: /\bRENAME\s+COLUMN\b/i },
  { name: "ALTER COLUMN ... TYPE (potentially lossy type change)", pattern: /\bALTER\s+COLUMN\s+"?[\w]+"?\s+TYPE\b/i },
];

/** Exported for unit testing without touching the filesystem. */
export function findDestructivePatterns(sqlText) {
  return DESTRUCTIVE_PATTERNS.filter(({ pattern }) => pattern.test(sqlText)).map(({ name }) => name);
}

function main() {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  let failed = false;

  for (const file of files) {
    if (KNOWN_HISTORICAL_EXCEPTIONS.has(file)) continue;
    const text = readFileSync(path.join(migrationsDir, file), "utf8");
    const found = findDestructivePatterns(text);
    if (found.length > 0) {
      failed = true;
      console.error(
        `[migration-safety] ${file} contains potentially destructive statement(s): ${found.join(", ")}. ` +
          `Prefer an additive migration (add new column/table, migrate data in application code, remove the ` +
          `old structure in a later migration once nothing depends on it). If this is genuinely necessary, ` +
          `it needs explicit Product Owner sign-off before being added to KNOWN_HISTORICAL_EXCEPTIONS in ` +
          `scripts/check-migration-safety.mjs — never add it to make CI pass without that sign-off.`,
      );
    }
  }

  if (failed) {
    process.exitCode = 1;
  } else {
    console.log(`[migration-safety] OK — no destructive statements found in ${files.length} migration file(s).`);
  }
}

// Only run when executed directly (`node scripts/check-migration-safety.mjs`), not when imported by
// its own test file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
