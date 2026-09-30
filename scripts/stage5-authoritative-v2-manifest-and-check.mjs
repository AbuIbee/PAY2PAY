#!/usr/bin/env node
/**
 * Stage 5 — RULE 16/17: builds authoritative-final-v2/manifest.json + manifest.md, and runs a
 * freeze-integrity checker that specifically targets the class of bug this order corrected
 * (Git-changed-path-count vs. freeze-entry-count mismatch, any changed path lacking an
 * existence/state record, duplicate paths, nonzero source drift, and any leading-dot path that
 * came out mangled) in addition to the ordinary per-command evidence completeness check.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const dir = path.join(repoRoot, "docs", "remediation", "stage5-evidence", "authoritative-final-v2");

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
  artifacts.push({ path: `docs/remediation/stage5-evidence/authoritative-final-v2/${relPath}`, label, exists: ok });
  if (!ok) issues.push(`MISSING required artifact: ${relPath} (${label})`);
  return ok;
}

need("source-freeze.json", "pre-campaign source freeze (NUL-delimited git discovery, hashes, HEAD, coverage)");
need("source-freeze-after.json", "post-campaign, INDEPENDENTLY re-derived source freeze");
need("source-freeze-drift.json", "before/after drift comparison (path-set, existence-state, content-hash, curated, migrations, CI workflow)");
need("campaign-summary.json", "top-level campaign result");
need("git-tracked-changed-raw-before.txt", "raw `git diff --name-only -z HEAD --` output, pre-campaign");
need("git-untracked-raw-before.txt", "raw `git ls-files --others --exclude-standard -z` output, pre-campaign");
need("git-tracked-changed-raw-after.txt", "raw tracked-changed output, post-campaign");
need("git-untracked-raw-after.txt", "raw untracked output, post-campaign");
need("changed-path-list-before.json", "final unioned, filtered changed-path list, pre-campaign");
need("changed-path-list-after.json", "final unioned, filtered changed-path list, post-campaign");
need("deployment-ordering.md", "G5-10 authoritative deployment-ordering evidence");
need("provider-boundary-check.txt", "provider-boundary evidence");
need("pre-push-inventory-git-status.txt", "pre-push inventory");
need("adversarial-preflight.md", "Codex-style adversarial preflight, including the freeze-logic-specific RULE 18 attack");

for (const step of REQUIRED_STEPS) {
  const cmdOk = need(`${step}.command.txt`, `${step}: command text`);
  const outOk = need(`${step}.stdout.txt`, `${step}: captured stdout`);
  const errOk = need(`${step}.stderr.txt`, `${step}: captured stderr`);
  const statusOk = need(`${step}.status.json`, `${step}: status sidecar`);
  if (statusOk) {
    const status = JSON.parse(readFileSync(path.join(dir, `${step}.status.json`), "utf8"));
    if (typeof status.exitCode !== "number") issues.push(`${step}.status.json has no captured numeric exit code`);
    if (!status.startTimestamp || !status.finishTimestamp) issues.push(`${step}.status.json is missing a start/finish timestamp`);
    if (!status.command || !status.cwd) issues.push(`${step}.status.json is missing command text or cwd`);
    if (status.exitCode !== 0) issues.push(`${step}.status.json reports a nonzero top-level exit code (${status.exitCode})`);
  }
  if (!cmdOk || !outOk || !errOk || !statusOk) issues.push(`${step}: incomplete four-file evidence set`);
}

// --- Freeze-integrity checks specific to this order's correction (RULE 16) ---
let freezeBefore = null;
let freezeAfter = null;
let drift = null;
if (existsSync(path.join(dir, "source-freeze.json"))) freezeBefore = JSON.parse(readFileSync(path.join(dir, "source-freeze.json"), "utf8"));
if (existsSync(path.join(dir, "source-freeze-after.json"))) freezeAfter = JSON.parse(readFileSync(path.join(dir, "source-freeze-after.json"), "utf8"));
if (existsSync(path.join(dir, "source-freeze-drift.json"))) drift = JSON.parse(readFileSync(path.join(dir, "source-freeze-drift.json"), "utf8"));

function checkFreezeCoverage(freeze, label) {
  if (!freeze) return;
  const changedCount = freeze.changedPaths.length;
  const entryCount = freeze.entries.length;
  if (changedCount !== entryCount) issues.push(`${label}: Git changed-path count (${changedCount}) differs from freeze-entry count (${entryCount})`);
  const entryPaths = new Set(freeze.entries.map((e) => e.path));
  for (const p of freeze.changedPaths) {
    if (!entryPaths.has(p)) issues.push(`${label}: changed path "${p}" has no freeze entry`);
  }
  const seen = new Set();
  for (const e of freeze.entries) {
    if (seen.has(e.path)) issues.push(`${label}: duplicate freeze entry path "${e.path}"`);
    seen.add(e.path);
    if (e.exists === false && e.state !== "deleted") issues.push(`${label}: entry "${e.path}" is nonexistent without an explicit deleted marker (state="${e.state}")`);
    // Leading-dot mangling check: any entry path containing "/.github/" or starting with
    // ".github" etc. must retain its leading dot exactly — this is the literal defect class.
    if (e.path.includes("github/workflows/ci.yml") && !e.path.startsWith(".github/")) {
      issues.push(`${label}: leading-dot path mangled — found "${e.path}" instead of ".github/workflows/ci.yml"`);
    }
  }
}
checkFreezeCoverage(freezeBefore, "source-freeze.json");
checkFreezeCoverage(freezeAfter, "source-freeze-after.json");

if (drift) {
  if (drift.totalSourceDrift !== 0) issues.push(`source-freeze-drift.json reports totalSourceDrift=${drift.totalSourceDrift}`);
}

const ciBefore = freezeBefore?.ciWorkflowEntry ?? null;
const ciCoverageStatus = ciBefore ? (ciBefore.path === ".github/workflows/ci.yml" && (ciBefore.exists ? typeof ciBefore.sha256 === "string" : ciBefore.state === "deleted") ? "PASS" : "FAIL") : "NOT-APPLICABLE";
if (ciCoverageStatus === "FAIL") issues.push("CI workflow freeze entry is malformed (present but neither a valid existing-file record nor an explicit deleted marker)");

if (existsSync(path.join(dir, "campaign-summary.json"))) {
  const summary = JSON.parse(readFileSync(path.join(dir, "campaign-summary.json"), "utf8"));
  if (summary.status !== "COMPLETE") issues.push(`campaign-summary.json status is "${summary.status}", not "COMPLETE"`);
  if (summary.totalSourceDrift !== 0) issues.push(`campaign-summary.json reports totalSourceDrift=${summary.totalSourceDrift}`);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  evidenceDirectory: "docs/remediation/stage5-evidence/authoritative-final-v2/",
  requiredSteps: REQUIRED_STEPS,
  artifacts,
  ciWorkflowCoverageStatus: ciCoverageStatus,
  integrityIssues: issues,
  integrityPass: issues.length === 0,
};
writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

const md = [
  "# Stage 5 Authoritative Final Evidence Manifest — V2 (source-freeze corrected)",
  "",
  `Generated: ${manifest.generatedAt}`,
  "",
  "Supersedes `authoritative-final/manifest.json`/`manifest.md` — see the closure report for why.",
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
  "## CI workflow freeze coverage",
  "",
  "```",
  `CI WORKFLOW FREEZE COVERAGE: ${ciCoverageStatus}`,
  "```",
  "",
  "## Freeze integrity result",
  "",
  "```",
  issues.length === 0 ? "SOURCE FREEZE INTEGRITY VALIDATION: PASS" : `SOURCE FREEZE INTEGRITY VALIDATION: FAIL (${issues.length} issue(s))`,
  "```",
  ...(issues.length > 0 ? ["", "### Issues", "", ...issues.map((i) => `- ${i}`)] : []),
  "",
  "## Overall manifest validation",
  "",
  "```",
  issues.length === 0 ? "AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: PASS" : `AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: FAIL (${issues.length} issue(s))`,
  "```",
  "",
].join("\n");
writeFileSync(path.join(dir, "manifest.md"), md);

console.log(`CI WORKFLOW FREEZE COVERAGE: ${ciCoverageStatus}`);
console.log(issues.length === 0 ? "SOURCE FREEZE INTEGRITY VALIDATION: PASS" : `SOURCE FREEZE INTEGRITY VALIDATION: FAIL (${issues.length} issue(s))`);
console.log(issues.length === 0 ? "AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: PASS" : `AUTHORITATIVE V2 EVIDENCE MANIFEST VALIDATION: FAIL (${issues.length} issue(s))`);
for (const i of issues) console.error(`  - ${i}`);
if (issues.length > 0) process.exitCode = 1;
