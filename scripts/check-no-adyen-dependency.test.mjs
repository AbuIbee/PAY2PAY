import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { findProductionRoots, isTestFile, projectRoot, runGraphCheck, srcDir } from "./check-no-sandbox-runtime.mjs";
import {
  ADYEN_CONTENT_RULES,
  findAdyenLockfileDependencies,
  findAdyenPackageJsonDependencies,
  isProhibitedAdyenTarget,
  packageJsonPath,
  packageLockPath,
} from "./check-no-adyen-dependency.mjs";

/**
 * REM-002 — mandatory regression tests. The graph-reachability cases (TEST 002-A, D, E, F, G, H)
 * write REAL, disposable files to a temporary directory and invoke the ACTUAL `runGraphCheck` engine
 * (the SAME one check-no-sandbox-runtime.mjs's own tests exercise, reused wholesale, per REM-002's own
 * instruction) — never a synthetic string passed into an isolated regex function. The manifest/lockfile
 * cases (TEST 002-B, C) invoke the ACTUAL `findAdyenPackageJsonDependencies`/`findAdyenLockfileDependencies`
 * functions against realistic JSON text shaped exactly like this repository's own files.
 */

const FIXTURE_COMPILER_OPTIONS_BASE = {
  paths: { "@/*": ["./src/*"] },
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
};

function makeFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adyen-scan-fixture-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(dir, relativePath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

function runAdyenFixture(dir, rootRelativePaths) {
  const compilerOptions = { ...FIXTURE_COMPILER_OPTIONS_BASE, baseUrl: dir };
  const roots = rootRelativePaths.map((p) => path.join(dir, p));
  const fixtureSrcDir = path.join(dir, "src");
  return runGraphCheck({
    roots,
    compilerOptions,
    rootSrcDir: fixtureSrcDir,
    isProhibitedTarget: isProhibitedAdyenTarget,
    prohibitedCategory: "adyen-class-reachable-from-production",
    prohibitedDetail: (file) => `adyen class reachable: ${file}`,
    contentRules: ADYEN_CONTENT_RULES,
  });
}

function runSandboxFixture(dir, rootRelativePaths) {
  const compilerOptions = { ...FIXTURE_COMPILER_OPTIONS_BASE, baseUrl: dir };
  const roots = rootRelativePaths.map((p) => path.join(dir, p));
  const fixtureSrcDir = path.join(dir, "src");
  return runGraphCheck({ roots, compilerOptions, rootSrcDir: fixtureSrcDir });
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("TEST 002-A — providerName: \"adyen\" in a provider registry, reached from a production root: FAIL — the registry-registration inspection code is actually invoked", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { REGISTRY } from "@/lib/providers/providerCapabilities";\nexport function handler() { return REGISTRY; }\n`,
    "src/lib/providers/providerCapabilities.ts": `export const REGISTRY = {\n  adyen: { providerName: "adyen", environment: "production", capabilities: ["ach_debit"] },\n};\n`,
  });
  try {
    const { violations } = runAdyenFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "adyen-provider-registration"), "a providerName: \"adyen\" registry entry must be rejected");
  } finally {
    cleanup(dir);
  }
});

test("TEST 002-B — Adyen package present ONLY in package-lock.json (no package.json declaration): FAIL — the lockfile inspection code is actually invoked", () => {
  const lockText = JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture" },
      "node_modules/next": { version: "16.0.0" },
      "node_modules/@adyen/adyen-web": { version: "6.0.0" },
    },
  });
  const offenders = findAdyenLockfileDependencies(lockText);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].name, "@adyen/adyen-web");
});

test("TEST 002-B2 — a nested/transitive Adyen lockfile entry is also caught", () => {
  const lockText = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/some-lib": { version: "1.0.0" },
      "node_modules/some-lib/node_modules/adyen-api-library": { version: "2.0.0" },
    },
  });
  const offenders = findAdyenLockfileDependencies(lockText);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].name, "adyen-api-library");
});

test("TEST 002-C — Adyen package declared in package.json dependencies: FAIL — the manifest inspection code is actually invoked", () => {
  const pkgText = JSON.stringify({
    dependencies: { next: "16.0.0", "@adyen/adyen-web": "^6.0.0" },
    devDependencies: { vitest: "^3.0.0" },
  });
  const offenders = findAdyenPackageJsonDependencies(pkgText);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].name, "@adyen/adyen-web");
  assert.equal(offenders[0].section, "dependencies");
});

test("TEST 002-D — direct production import of an Adyen-named module: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { AdyenPaymentProvider } from "@/lib/payments/adyenPaymentProvider";\nexport function handler() { return new AdyenPaymentProvider(); }\n`,
    "src/lib/payments/adyenPaymentProvider.ts": `export class AdyenPaymentProvider {}\n`,
  });
  try {
    const { violations } = runAdyenFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "adyen-class-reachable-from-production" || v.category === "adyen-module-import"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 002-E — indirect production import of an Adyen-named module through a barrel: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { getProvider } from "@/lib/payments/barrel";\nexport function handler() { return getProvider(); }\n`,
    "src/lib/payments/barrel.ts": `export { AdyenPaymentProvider as getProvider } from "@/lib/payments/adyenPaymentProvider";\n`,
    "src/lib/payments/adyenPaymentProvider.ts": `export class AdyenPaymentProvider {}\n`,
  });
  try {
    const { violations } = runAdyenFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.length > 0);
  } finally {
    cleanup(dir);
  }
});

test("TEST 002-F — Adyen registration without any sandbox terminology anywhere: FAIL — detection is independent of the word 'sandbox'", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { REGISTRY } from "@/lib/providers/registry";\nexport function handler() { return REGISTRY; }\n`,
    "src/lib/providers/registry.ts": `export const REGISTRY = { adyen: { providerName: "adyen", environment: "production", capabilities: [] } };\n`,
  });
  try {
    const files = ["src/app/api/payments/route.ts", "src/lib/providers/registry.ts"];
    for (const f of files) assert.ok(!/sandbox/i.test(readFixtureFile(dir, f)), `fixture ${f} must contain no sandbox terminology`);
    const { violations } = runAdyenFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "adyen-provider-registration"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 002-G — a sandbox provider without any Adyen terminology: the SANDBOX gate fails independently, the ADYEN gate stays clean — proves the two policies operate independently", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";\nexport function handler() { return new SandboxPaymentProvider(); }\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": `export class SandboxPaymentProvider {}\n`,
  });
  try {
    for (const f of ["src/app/api/payments/route.ts", "src/test-support/payments/sandboxPaymentProvider.ts"]) {
      assert.ok(!/adyen/i.test(readFixtureFile(dir, f)), `fixture ${f} must contain no Adyen terminology`);
    }
    const sandboxResult = runSandboxFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(sandboxResult.violations.some((v) => v.category === "sandbox-provider-reachable-from-production"), "the sandbox gate must fail on its own");

    const adyenResult = runAdyenFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.deepEqual(adyenResult.violations, [], "the Adyen gate must stay clean — it shares no detection logic with the sandbox gate's own class-name pattern");
  } finally {
    cleanup(dir);
  }
});

test("TEST 002-H — historical documentation mentioning Adyen in a doc comment, no executable reference: PASS", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `/**\n * This architecture excludes Adyen completely — no Adyen dependency, import, or registration\n * exists anywhere in this codebase. See docs/PRODUCTION_PROVIDER_READINESS.md.\n */\nexport function handler() { return "ok"; }\n`,
  });
  try {
    const { violations } = runAdyenFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.deepEqual(violations, []);
  } finally {
    cleanup(dir);
  }
});

test("TEST 002-I — the live scan against the REAL, current V3 production tree, package.json, and package-lock.json is clean", () => {
  const compilerOptions = (() => {
    const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath)).options;
  })();
  const roots = findProductionRoots(srcDir, projectRoot);
  const { violations } = runGraphCheck({
    roots,
    compilerOptions,
    rootSrcDir: srcDir,
    isProhibitedTarget: isProhibitedAdyenTarget,
    prohibitedCategory: "adyen-class-reachable-from-production",
    prohibitedDetail: (file) => `adyen class reachable: ${file}`,
    contentRules: ADYEN_CONTENT_RULES,
  });
  assert.deepEqual(violations, [], `Adyen runtime violations found in the real project: ${JSON.stringify(violations, null, 2)}`);

  const packageJsonOffenders = findAdyenPackageJsonDependencies(readFileSync(packageJsonPath, "utf8"));
  assert.deepEqual(packageJsonOffenders, []);
  const lockfileOffenders = findAdyenLockfileDependencies(readFileSync(packageLockPath, "utf8"));
  assert.deepEqual(lockfileOffenders, []);
});

test("isTestFile is reused unchanged from check-no-sandbox-runtime.mjs — Adyen gate roots are the same production entry points", () => {
  assert.equal(isTestFile("route.test.ts"), true);
  assert.equal(isTestFile("route.ts"), false);
});

function readFixtureFile(dir, relativePath) {
  return readFileSync(path.join(dir, relativePath), "utf8");
}
