#!/usr/bin/env node
/**
 * Stage 5 — RULE 16: builds manifest.json/manifest.md enumerating every required authoritative
 * artifact, then runs a machine integrity check that fails if any file is missing, any status
 * sidecar is missing an exit code, any command/output pair is incomplete, any expected run is
 * absent, or the source-freeze drift record shows nonzero drift.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const dir = path.join(repoRoot, "docs", "remediation", "stage5-evidence", "authoritative-final");

const REQUIRED_STEPS = [
  "01-schema-parity-and-index-extraction",
  "02-verifier-self-validation",
  "03-forward-upgrade",
  "04-migration-runner-proof",
  "05-stage4-regression",
  "06-typecheck",
  "07-lint",
  "08-broader-regression-run-1",
  "09-broader-regression-run-2",
  "10-broader-regression-run-3",
];

const issues = [];
const artifacts = [];

function need(relPath, label) {
  const abs = path.join(dir, relPath);
  const ok = existsSync(abs);
  artifacts.push({ path: `docs/remediation/stage5-evidence/authoritative-final/${relPath}`, label, exists: ok });
  if (!ok) issues.push(`MISSING required artifact: ${relPath} (${label})`);
  return ok;
}

need("source-freeze.json", "pre-campaign source freeze (hashes, HEAD, git status)");
need("source-freeze-after.json", "post-campaign source freeze recomputation");
need("source-freeze-drift.json", "source drift comparison result");
need("campaign-summary.json", "top-level campaign result");
need("deployment-ordering.md", "G5-10 authoritative deployment-ordering evidence (documentation-only addition, no technical source changed)");

for (const step of REQUIRED_STEPS) {
  const cmdOk = need(`${step}.command.txt`, `${step}: command text`);
  const outOk = need(`${step}.stdout.txt`, `${step}: captured stdout`);
  const errOk = need(`${step}.stderr.txt`, `${step}: captured stderr`);
  const statusOk = need(`${step}.status.json`, `${step}: status sidecar`);
  if (statusOk) {
    const status = JSON.parse(readFileSync(path.join(dir, `${step}.status.json`), "utf8"));
    if (typeof status.exitCode !== "number") issues.push(`${step}.status.json has no captured numeric exit code (got ${JSON.stringify(status.exitCode)})`);
    if (!status.startTimestamp || !status.finishTimestamp) issues.push(`${step}.status.json is missing a start/finish timestamp`);
    if (!status.command) issues.push(`${step}.status.json is missing its command text`);
    if (!status.cwd) issues.push(`${step}.status.json is missing its working directory`);
    if (status.sourceFreezeId !== undefined && !status.sourceFreezeId) issues.push(`${step}.status.json is missing its source-freeze identifier`);
    // Every required command in this campaign is expected to exit 0 (there is no deliberate
    // top-level nonzero exit anywhere in this specific step list — the deliberate failure/retry
    // exit lives INSIDE step 04's own internal migration-runner-proof phases, not as that
    // script's own top-level exit code).
    if (status.exitCode !== 0) issues.push(`${step}.status.json reports a nonzero top-level exit code (${status.exitCode}) — this campaign requires all 10 top-level steps to exit 0`);
  }
  if (!cmdOk || !outOk || !errOk || !statusOk) issues.push(`${step}: incomplete four-file evidence set`);
}

// Source-freeze integrity.
if (existsSync(path.join(dir, "source-freeze-drift.json"))) {
  const drift = JSON.parse(readFileSync(path.join(dir, "source-freeze-drift.json"), "utf8"));
  if (drift.driftCount !== 0) issues.push(`source-freeze-drift.json reports ${drift.driftCount} drifted file(s) — campaign source was not frozen`);
}
if (existsSync(path.join(dir, "campaign-summary.json"))) {
  const summary = JSON.parse(readFileSync(path.join(dir, "campaign-summary.json"), "utf8"));
  if (summary.status !== "COMPLETE") issues.push(`campaign-summary.json status is "${summary.status}", not "COMPLETE"`);
  if (summary.sourceDriftCount !== 0) issues.push(`campaign-summary.json reports sourceDriftCount=${summary.sourceDriftCount}`);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  evidenceDirectory: "docs/remediation/stage5-evidence/authoritative-final/",
  requiredSteps: REQUIRED_STEPS,
  artifacts,
  integrityIssues: issues,
  integrityPass: issues.length === 0,
};
writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

const md = [
  "# Stage 5 Authoritative Final Evidence Manifest",
  "",
  `Generated: ${manifest.generatedAt}`,
  "",
  "## Required steps (in execution order)",
  "",
  ...REQUIRED_STEPS.map((s, i) => `${i + 1}. \`${s}\` — command.txt, stdout.txt, stderr.txt, status.json`),
  "",
  "## Artifact existence",
  "",
  "| Artifact | Label | Exists |",
  "|---|---|---|",
  ...artifacts.map((a) => `| \`${a.path}\` | ${a.label} | ${a.exists ? "YES" : "**MISSING**"} |`),
  "",
  "## Integrity result",
  "",
  "```",
  issues.length === 0 ? "AUTHORITATIVE EVIDENCE MANIFEST VALIDATION: PASS" : `AUTHORITATIVE EVIDENCE MANIFEST VALIDATION: FAIL (${issues.length} issue(s))`,
  "```",
  ...(issues.length > 0 ? ["", "### Issues", "", ...issues.map((i) => `- ${i}`)] : []),
  "",
].join("\n");
writeFileSync(path.join(dir, "manifest.md"), md);

console.log(issues.length === 0 ? "AUTHORITATIVE EVIDENCE MANIFEST VALIDATION: PASS" : `AUTHORITATIVE EVIDENCE MANIFEST VALIDATION: FAIL (${issues.length} issue(s))`);
for (const i of issues) console.error(`  - ${i}`);
if (issues.length > 0) process.exitCode = 1;
