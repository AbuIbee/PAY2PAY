#!/usr/bin/env node
/**
 * REM-002 (PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE): an INDEPENDENT CI regression gate,
 * separate from check-no-sandbox-runtime.mjs (its own gate, its own pass/fail signal, its own CI step
 * — see .github/workflows/ci.yml), that fails if Adyen is ever reintroduced into this architecture, as:
 *
 *   1. RUNTIME REACHABILITY: a real production entry point (src/app/**, src/config/**, next.config.ts)
 *      whose dependency graph — imports, re-exports, export-all, literal dynamic import()/require(),
 *      through any number of intermediary modules, including ones inside src/test-support/ or a
 *      *testFakes.ts(x) file (no exemption exists for this rule at all — there is no sanctioned home
 *      for Adyen anywhere in this codebase) — reaches a file that declares an `Adyen*` class, imports
 *      an `@adyen/*`-style package, or references an `ADYEN_`-prefixed identifier as executable code.
 *      REM-002 REUSES REM-001's dependency-graph engine (`runGraphCheck`,
 *      `findProductionRoots`, `resolveSpecifier`, `extractModuleReferences`) wholesale — the traversal
 *      mechanics (module resolution, path-alias handling, chain tracking) are IDENTICAL; only the
 *      "what counts as prohibited" predicate differs.
 *   2. PROVIDER REGISTRATION: `providerName: "adyen"` (or any other provider-selection field this
 *      repository actually uses) assigned as CODE in a provider registry/configuration structure — not
 *      merely the three env-var-literal checks the OLD version of this script was limited to.
 *   3. PACKAGE MANIFEST: package.json's dependencies/devDependencies/optionalDependencies/
 *      peerDependencies sections.
 *   4. DEPENDENCY LOCKFILE: package-lock.json (this repo's actual lockfileVersion 3 format — a flat
 *      `packages` map keyed by `node_modules/<name>` paths, including nested transitive entries like
 *      `node_modules/@scope/x/node_modules/y`) — catching an Adyen package present ONLY in the
 *      lockfile (installed with `--no-save`, or left behind as a stale/transitive entry) even when
 *      package.json itself declares nothing.
 *
 * Excludes only *.test.ts(x) files from being a production ROOT (a test may legitimately assert an
 * "adyen" value is rejected) — no test-support/ or testFakes exemption exists for reachability at all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractModuleReferences, findProductionRoots, loadCompilerOptions, projectRoot, runGraphCheck, srcDir } from "./check-no-sandbox-runtime.mjs";

export const packageJsonPath = path.join(projectRoot, "package.json");
export const packageLockPath = path.join(projectRoot, "package-lock.json");

const ADYEN_MODULE_SPECIFIER_PATTERN = /adyen/i;
const ADYEN_CLASS_DECLARATION_PATTERN = /\bclass\s+Adyen\w*/;
/** An ADYEN_-prefixed identifier actually used as a property key or assignment target — not a bare mention of the word "Adyen" in prose. */
const ADYEN_ENV_VAR_USAGE_PATTERN = /\bADYEN_[A-Z0-9_]*\s*(?::|=[^=])/;
const FORBIDDEN_PROVIDER_LITERAL_ADYEN_PATTERN = /(PAYMENT_PROVIDER|KYC_PROVIDER|CARD_ISSUING_PROVIDER)\s*[:=]\s*["']adyen["']/i;
/**
 * REM-002 gap fix: the actual provider-selection field this repository's own registry
 * (src/lib/providers/providerCapabilities.ts's `ProviderCapabilityDescriptor.providerName`) uses to
 * name a registered provider — a registry ENTRY reading `providerName: "adyen"` was NOT caught by any
 * pattern in the prior version of this script (confirmed by direct execution during the governing
 * control order's independent verification pass). Matches the field name immediately followed by a
 * quoted value containing "adyen", as CODE (a property assignment), not prose.
 */
const ADYEN_PROVIDER_REGISTRATION_PATTERN = /providerName\s*:\s*["'][^"']*adyen[^"']*["']/i;

export function isProhibitedAdyenTarget(_file, text) {
  return ADYEN_CLASS_DECLARATION_PATTERN.test(text);
}

export const ADYEN_CONTENT_RULES = [
  {
    category: "adyen-module-import",
    test: (text, file) => {
      for (const ref of extractModuleReferencesSafely(file, text)) {
        if (ref.specifier && ADYEN_MODULE_SPECIFIER_PATTERN.test(ref.specifier)) return true;
      }
      return false;
    },
    detail: (text, file) => {
      const ref = extractModuleReferencesSafely(file, text).find((r) => r.specifier && ADYEN_MODULE_SPECIFIER_PATTERN.test(r.specifier));
      return ref ? `${ref.kind} "${ref.specifier}"` : "adyen-named module reference";
    },
  },
  {
    category: "adyen-env-var-usage",
    test: (text) => ADYEN_ENV_VAR_USAGE_PATTERN.test(text),
    detail: (text) => text.match(ADYEN_ENV_VAR_USAGE_PATTERN)[0].trim(),
  },
  {
    category: "forbidden-provider-literal-adyen",
    test: (text) => FORBIDDEN_PROVIDER_LITERAL_ADYEN_PATTERN.test(text),
    detail: (text) => text.match(FORBIDDEN_PROVIDER_LITERAL_ADYEN_PATTERN)[0],
  },
  {
    category: "adyen-provider-registration",
    test: (text) => ADYEN_PROVIDER_REGISTRATION_PATTERN.test(text),
    detail: (text) => text.match(ADYEN_PROVIDER_REGISTRATION_PATTERN)[0],
  },
];

// `detail`/`test` above need parsed module references but ADYEN_CONTENT_RULES entries only receive
// (text, file) — re-parsing per rule invocation is wasteful but correctness-preserving and simple;
// this script runs in CI/pre-commit, not a hot path. Failures to parse (a file `extractModuleReferences`
// cannot handle) are swallowed here exactly like the shared engine's own top-level catch does.
function extractModuleReferencesSafely(file, text) {
  try {
    return extractModuleReferences(file, text);
  } catch {
    return [];
  }
}

function packageNameFromLockfileKey(key) {
  const idx = key.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const rest = key.slice(idx + "node_modules/".length);
  if (rest.startsWith("@")) {
    const parts = rest.split("/");
    return parts.slice(0, 2).join("/");
  }
  return rest.split("/")[0];
}

/** Exported for unit testing without touching the filesystem. Returns offending {name} entries, empty when clean. */
export function findAdyenPackageJsonDependencies(packageJsonText) {
  const pkg = JSON.parse(packageJsonText);
  const offenders = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (ADYEN_MODULE_SPECIFIER_PATTERN.test(name)) offenders.push({ section, name });
    }
  }
  return offenders;
}

/**
 * Exported for unit testing without touching the filesystem. Parses this repository's ACTUAL
 * package-lock.json shape (lockfileVersion 3: a flat `packages` map keyed by `node_modules/<name>`
 * paths, including nested transitive entries) — catches an Adyen package present ONLY in the lockfile,
 * with no corresponding package.json declaration at all.
 */
export function findAdyenLockfileDependencies(packageLockText) {
  const lock = JSON.parse(packageLockText);
  const offenders = [];
  const seen = new Set();
  for (const key of Object.keys(lock.packages ?? {})) {
    if (key === "") continue; // the root project entry itself.
    const name = packageNameFromLockfileKey(key);
    if (name && ADYEN_MODULE_SPECIFIER_PATTERN.test(name) && !seen.has(name)) {
      seen.add(name);
      offenders.push({ name, lockfileKey: key });
    }
  }
  // Older lockfile formats (lockfileVersion < 3) nest a nameable `dependencies` tree instead — handled
  // too, for robustness, even though this repository's own lockfile is v3.
  (function walkLegacy(deps, prefix = "") {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      if (ADYEN_MODULE_SPECIFIER_PATTERN.test(name) && !seen.has(name)) {
        seen.add(name);
        offenders.push({ name, lockfileKey: `${prefix}${name}` });
      }
      if (info && typeof info === "object" && info.dependencies) walkLegacy(info.dependencies, `${prefix}${name}/`);
    }
  })(lock.dependencies);
  return offenders;
}

function main() {
  let failed = false;

  const packageJsonOffenders = findAdyenPackageJsonDependencies(readFileSync(packageJsonPath, "utf8"));
  for (const offender of packageJsonOffenders) {
    failed = true;
    console.error(`[no-adyen-dependency] package.json: adyen-package-dependency — "${offender.name}" listed under ${offender.section}`);
  }

  const lockfileOffenders = findAdyenLockfileDependencies(readFileSync(packageLockPath, "utf8"));
  for (const offender of lockfileOffenders) {
    failed = true;
    console.error(`[no-adyen-dependency] package-lock.json: adyen-lockfile-dependency — "${offender.name}" present at "${offender.lockfileKey}"`);
  }

  const compilerOptions = loadCompilerOptions(projectRoot);
  const roots = findProductionRoots(srcDir, projectRoot);
  const { violations, scannedCount } = runGraphCheck({
    roots,
    compilerOptions,
    rootSrcDir: srcDir,
    isProhibitedTarget: isProhibitedAdyenTarget,
    prohibitedCategory: "adyen-class-reachable-from-production",
    prohibitedDetail: (file) => `Production entry point can reach an Adyen-named class implementation: ${path.relative(srcDir, file)}`,
    contentRules: ADYEN_CONTENT_RULES,
  });
  if (violations.length > 0) failed = true;
  for (const v of violations) {
    const chainDisplay = v.chain.map((f) => path.relative(projectRoot, f)).join("\n      -> ");
    console.error(
      `[no-adyen-dependency] VIOLATION (${v.category})\n` +
        `  Production entry point: ${path.relative(projectRoot, v.root)}\n` +
        `  Dependency chain:\n      -> ${chainDisplay}\n` +
        `  Detail: ${v.detail}`,
    );
  }

  if (failed) {
    console.error(
      "\n[no-adyen-dependency] FAILED — Adyen has been reintroduced into the V3 bank-managed-payments architecture " +
        "(as reachable production source, a provider registration, a package.json dependency, or a package-lock.json " +
        "entry). Adyen is explicitly and completely excluded from this architecture.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[no-adyen-dependency] OK — no Adyen runtime reference reachable from ${roots.length} production entry point(s) across ${scannedCount} module(s), ` +
        "no Adyen provider registration, no Adyen package.json dependency, no Adyen package-lock.json entry.",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
