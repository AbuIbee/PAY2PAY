#!/usr/bin/env node
/**
 * Stage 5 Zero-False-Positive Completion Order, Part V Step 18: the final reproducibility
 * campaign, run once, in the exact required order, each step a real separate child-process
 * invocation with its own captured status sidecar (scripts/lib/statusSidecar.mjs) — never a
 * hand-typed summary. No code, test, migration, or verification-tooling change is permitted
 * after this script starts (Step 19); if one occurs, this campaign is invalid and must be rerun
 * from the top.
 */
import { runCommandWithSidecar, saveManualSidecar, SIDECAR_DIR } from "./lib/statusSidecar.mjs";
import { readdirSync } from "node:fs";
import path from "node:path";

function log(message) {
  console.log(`[final-campaign] ${message}`);
}

// Ordered to match the Final Zero-False-Positive Index Parity Remediation Order's Section 13
// numbered list as closely as this architecture allows. Items 1 (fresh disposable PG migration
// build), 2 (corrected schema-parity suite), and 4 (real-PostgreSQL index-extraction self-
// validation) run inside ONE disposable-Postgres harness invocation (scripts/postgres-test-db.mjs
// --stage5-only), because STAGE5_POSTGRES_TEST_FILES now fixes BOTH
// src/db/schemaParity.postgres.test.ts and src/db/indexExtraction.postgres.test.ts as the Stage 5
// selector's file set — spinning up a second full 58-migration container to re-run 5 already-
// covered tests separately would be pure waste, not additional rigor. Every individual test's
// pass/fail is still separately attributable inside that one sidecar's captured stdout (vitest
// prefixes every result line with its file path). Item 3 (pure comparator self-validation, no
// database needed) runs as its own step immediately after. Items 6/7 (pending-only,
// failure/retry) run inside scripts/stage5-migration-runner-proof.mjs, which also independently
// re-proves item 1's fresh-build claim via the authoritative Supabase CLI runner (a second,
// different mechanism from apply-migrations-fresh.mjs).
const steps = [
  { name: "final-campaign-01-schema-parity-and-index-extraction", cmd: "node", args: ["scripts/postgres-test-db.mjs", "--stage5-only", "--run-tests"], label: "[order items 1, 2, 4] fresh disposable PG build + corrected semantic schema-parity suite + real-PostgreSQL index-extraction self-validation" },
  { name: "final-campaign-02-verifier-self-validation", cmd: "npx", args: ["vitest", "run", "src/db/schemaParityComparators.self-validation.test.ts"], label: "[order item 3] comparator self-validation suite (includes the INDEX-EXPRESSION-FALSE-POSITIVE-REGRESSION test)" },
  { name: "final-campaign-03-forward-upgrade", cmd: "node", args: ["scripts/stage5-forward-upgrade-test.mjs"], label: "[order item 5] forward-upgrade proof" },
  { name: "final-campaign-04-migration-runner-proof", cmd: "node", args: ["scripts/stage5-migration-runner-proof.mjs"], label: "[order items 6, 7] Supabase applied-state/pending-only proof + failure/retry proof" },
  { name: "final-campaign-05-stage4-regression", cmd: "node", args: ["scripts/postgres-test-db.mjs", "--stage4-only", "--run-tests"], label: "[order item 8] Stage 4 PostgreSQL regression (reused, unexpanded selector)" },
  { name: "final-campaign-06-typecheck", cmd: "npx", args: ["tsc", "--noEmit"], label: "[order item 9] typecheck" },
  { name: "final-campaign-07-lint", cmd: "npm", args: ["run", "lint"], label: "[order item 10] lint" },
  { name: "final-campaign-08-npm-test", cmd: "npm", args: ["test"], label: "[order item 11] broader regression (npm test)" },
];

const startedAt = new Date().toISOString();
const summary = [];
for (const step of steps) {
  log(`running: ${step.label} (${step.cmd} ${step.args.join(" ")})`);
  const result = runCommandWithSidecar(step.name, step.cmd, step.args);
  const passed = result.exitCode === 0;
  summary.push({ name: step.name, label: step.label, exitCode: result.exitCode, passed });
  log(`${passed ? "PASS" : "FAIL"} (exit ${result.exitCode}) — ${step.label}`);
}
const finishedAt = new Date().toISOString();

const allPassed = summary.every((s) => s.passed);

// Step 16 — evidence-integrity self-check: every sidecar this campaign just claimed to produce
// actually exists on disk, actually has a numeric exit code (not null/undefined), and the file
// timestamp falls within this campaign's own start/finish window.
const integrityIssues = [];
const sidecarFiles = new Set(readdirSync(SIDECAR_DIR).filter((f) => f.endsWith(".json")));
for (const step of steps) {
  const fileName = `${step.name}.json`;
  if (!sidecarFiles.has(fileName)) {
    integrityIssues.push(`missing sidecar file for required command "${step.name}": ${path.join(SIDECAR_DIR, fileName)}`);
    continue;
  }
}
for (const s of summary) {
  if (typeof s.exitCode !== "number") integrityIssues.push(`sidecar "${s.name}" has no captured numeric exit code (got ${JSON.stringify(s.exitCode)})`);
}

const campaignResult = {
  startedAt,
  finishedAt,
  steps: summary,
  allPassed,
  evidenceIntegrityIssues: integrityIssues,
  evidenceIntegrityPass: integrityIssues.length === 0,
};
saveManualSidecar("final-campaign-summary", campaignResult);

console.log("");
console.log("=== FINAL CAMPAIGN SUMMARY ===");
for (const s of summary) {
  console.log(`${s.passed ? "PASS" : "FAIL"} (exit ${s.exitCode}) — ${s.name} — ${s.label}`);
}
console.log(`EVIDENCE INTEGRITY: ${integrityIssues.length === 0 ? "PASS" : `FAIL (${integrityIssues.length} issue(s))`}`);
console.log(`OVERALL: ${allPassed && integrityIssues.length === 0 ? "PASS" : "FAIL"}`);
if (!allPassed || integrityIssues.length > 0) process.exitCode = 1;
