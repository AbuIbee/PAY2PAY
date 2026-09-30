import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import {
  extractModuleReferences,
  findProductionRoots,
  isTestFile,
  projectRoot,
  resolveSpecifier,
  runGraphCheck,
  srcDir,
} from "./check-no-sandbox-runtime.mjs";

/**
 * REM-001 — mandatory regression tests. Every FAIL/PASS test below writes REAL, disposable files to a
 * temporary directory and invokes the ACTUAL `runGraphCheck` graph traversal against them (starting
 * from a real production root file and following the real dependency chain) — never a synthetic string
 * passed into an isolated regex function. Each fixture is created fresh per test and removed afterward.
 */

const FIXTURE_COMPILER_OPTIONS = {
  baseUrl: null, // set per-fixture, since baseUrl must be an absolute path matching the fixture dir.
  paths: { "@/*": ["./src/*"] },
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  jsx: ts.JsxEmit.ReactJSX,
};

function makeFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sandbox-scan-fixture-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(dir, relativePath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

function runFixture(dir, rootRelativePaths) {
  const compilerOptions = { ...FIXTURE_COMPILER_OPTIONS, baseUrl: dir };
  const roots = rootRelativePaths.map((p) => path.join(dir, p));
  const fixtureSrcDir = path.join(dir, "src");
  return runGraphCheck({ roots, compilerOptions, rootSrcDir: fixtureSrcDir });
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const SANDBOX_PROVIDER_SOURCE = `export class SandboxPaymentProvider {\n  providerName = "sandbox_mock";\n  async createPayment() { return { status: "succeeded" }; }\n}\n`;

test("TEST 001-A — production root imports sandbox provider directly: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";\nexport function handler() { return new SandboxPaymentProvider(); }\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-B — production root imports a barrel that re-exports sandbox provider: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { SandboxPaymentProvider } from "@/lib/payments/barrel";\nexport function handler() { return new SandboxPaymentProvider(); }\n`,
    "src/lib/payments/barrel.ts": `export { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-C — THE EXACT CODEX-CONFIRMED BYPASS: production root -> ordinary helper -> test-support intermediary -> sandbox provider re-exported under a different name: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { getProvider } from "@/lib/payments/getPaymentProvider";\nexport function handler() { return getProvider(); }\n`,
    "src/lib/payments/getPaymentProvider.ts": `import { LiveLookingProvider } from "@/test-support/payments/innocuousIntermediary";\nexport function getProvider() { return new LiveLookingProvider(); }\n`,
    // The intermediary lives INSIDE test-support/ (previously wholesale excluded from scanning) and
    // re-exports the sandbox class under a completely innocuous name.
    "src/test-support/payments/innocuousIntermediary.ts": `export { SandboxPaymentProvider as LiveLookingProvider } from "./sandboxPaymentProvider";\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(
      violations.some((v) => v.category === "sandbox-provider-reachable-from-production"),
      "the excluded-intermediary bypass must be closed: a production root reaching a test-support re-export must fail",
    );
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-D — same as C, but with two additional intermediary modules: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { getProvider } from "@/lib/payments/getPaymentProvider";\nexport function handler() { return getProvider(); }\n`,
    "src/lib/payments/getPaymentProvider.ts": `import { StepA } from "@/lib/payments/stepA";\nexport function getProvider() { return new StepA(); }\n`,
    "src/lib/payments/stepA.ts": `export { StepB as StepA } from "@/lib/payments/stepB";\n`,
    "src/lib/payments/stepB.ts": `export { LiveLookingProvider as StepB } from "@/test-support/payments/innocuousIntermediary";\n`,
    "src/test-support/payments/innocuousIntermediary.ts": `export { SandboxPaymentProvider as LiveLookingProvider } from "./sandboxPaymentProvider";\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
    const violation = violations.find((v) => v.category === "sandbox-provider-reachable-from-production");
    assert.ok(violation.chain.length >= 5, "the reported chain should preserve every intermediary hop");
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-E — production root imports a testFakes.ts intermediary that re-exports the sandbox provider: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { LiveLookingProvider } from "@/lib/payments/testFakes";\nexport function handler() { return new LiveLookingProvider(); }\n`,
    "src/lib/payments/testFakes.ts": `export { SandboxPaymentProvider as LiveLookingProvider } from "@/test-support/payments/sandboxPaymentProvider";\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-F — multiline named import spanning several lines reaches the sandbox provider: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import {\n  SandboxPaymentProvider,\n} from "@/test-support/payments/sandboxPaymentProvider";\nexport function handler() { return new SandboxPaymentProvider(); }\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-G — literal dynamic import() reaches the sandbox provider: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `export async function handler() {\n  const mod = await import("@/test-support/payments/sandboxPaymentProvider");\n  return new mod.SandboxPaymentProvider();\n}\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-H — CommonJS require() reaches the sandbox provider: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `const { SandboxPaymentProvider } = require("@/test-support/payments/sandboxPaymentProvider");\nmodule.exports = function handler() { return new SandboxPaymentProvider(); };\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-I — configured TypeScript path alias (@/...) reaches the sandbox provider: FAIL", () => {
  // Deliberately uses the SAME "@/*" alias convention this real project's own tsconfig.json declares —
  // proves alias resolution (not just relative paths) is honored by the graph traversal.
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";\nexport function handler() { return new SandboxPaymentProvider(); }\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-J — an unresolved local import exists: FAIL with a resolution diagnostic", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { Whatever } from "@/lib/payments/thisFileDoesNotExist";\nexport function handler() { return Whatever; }\n`,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    const unresolved = violations.find((v) => v.category === "unresolved-local-import");
    assert.ok(unresolved, "an unresolved local import must never be silently treated as safe");
    assert.ok(unresolved.detail.includes("thisFileDoesNotExist"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-K — a legitimate test file imports a sandbox fake, but no production root reaches it: PASS", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `export function handler() { return "ok"; }\n`,
    "src/lib/payments/paymentService.test.ts": `import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";\ntest("uses the sandbox double", () => { new SandboxPaymentProvider(); });\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    // The test file is never a production root (isTestFile excludes it from findProductionRoots), and
    // no production root's own import graph reaches it either.
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.deepEqual(
      violations.filter((v) => v.category === "sandbox-provider-reachable-from-production"),
      [],
    );
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-L — clean application dependency graph: PASS", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { helper } from "@/lib/payments/helper";\nexport function handler() { return helper(); }\n`,
    "src/lib/payments/helper.ts": `export function helper() { return "ok"; }\n`,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.deepEqual(violations, []);
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-M — a JavaScript (.js) intermediary imports the sandbox provider: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { getProvider } from "@/lib/payments/legacyHelper.js";\nexport function handler() { return getProvider(); }\n`,
    "src/lib/payments/legacyHelper.js": `import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";\nexport function getProvider() { return new SandboxPaymentProvider(); }\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-M2 — an .mjs intermediary re-exporting the sandbox provider: FAIL", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `import { getProvider } from "@/lib/payments/legacyHelper.mjs";\nexport function handler() { return getProvider(); }\n`,
    "src/lib/payments/legacyHelper.mjs": `export { SandboxPaymentProvider as getProvider } from "@/test-support/payments/sandboxPaymentProvider";\n`,
    "src/test-support/payments/sandboxPaymentProvider.ts": SANDBOX_PROVIDER_SOURCE,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.ok(violations.some((v) => v.category === "sandbox-provider-reachable-from-production"));
  } finally {
    cleanup(dir);
  }
});

test("TEST 001-N — a module contains only a historical sandbox comment: PASS", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `/**\n * Sandbox/mock provider implementations (SandboxPaymentProvider) still exist only as test doubles\n * under src/test-support/ — never imported from this file or any production runtime path.\n */\nexport function handler() { return "ok"; }\n`,
  });
  try {
    const { violations } = runFixture(dir, ["src/app/api/payments/route.ts"]);
    assert.deepEqual(violations, []);
  } finally {
    cleanup(dir);
  }
});

test("isTestFile / findProductionRoots — test files are never roots, ordinary app/config files are", () => {
  const dir = makeFixture({
    "src/app/api/payments/route.ts": `export function handler() { return "ok"; }\n`,
    "src/app/api/payments/route.test.ts": `test("noop", () => {});\n`,
    "src/config/env.ts": `export const env = {};\n`,
  });
  try {
    assert.equal(isTestFile("route.test.ts"), true);
    assert.equal(isTestFile("route.ts"), false);
    const roots = findProductionRoots(path.join(dir, "src"), dir);
    const relRoots = roots.map((r) => path.relative(dir, r).split(path.sep).join("/"));
    assert.ok(relRoots.includes("src/app/api/payments/route.ts"));
    assert.ok(!relRoots.includes("src/app/api/payments/route.test.ts"));
    assert.ok(relRoots.includes("src/config/env.ts"));
  } finally {
    cleanup(dir);
  }
});

test("extractModuleReferences finds import/re-export/export-all/dynamic-import/require, ignores non-literal dynamic references", () => {
  const text = `
import { A } from "./a";
export { B } from "./b";
export * from "./c";
const d = await import("./d");
const e = require("./e");
const specifier = computeIt();
const f = await import(specifier);
`;
  const refs = extractModuleReferences("/virtual/file.ts", text);
  const specifiers = refs.map((r) => r.specifier).filter(Boolean);
  assert.deepEqual(specifiers.sort(), ["./a", "./b", "./c", "./d", "./e"].sort());
  assert.ok(refs.some((r) => r.kind === "dynamic-import-unresolvable"));
});

test("resolveSpecifier treats bare package specifiers and non-code assets as external, never traversed", () => {
  const dir = makeFixture({ "src/app/x.ts": `export const x = 1;\n` });
  try {
    const compilerOptions = { ...FIXTURE_COMPILER_OPTIONS, baseUrl: dir };
    assert.equal(resolveSpecifier("react", path.join(dir, "src/app/x.ts"), compilerOptions).kind, "external");
    assert.equal(resolveSpecifier("./app-shell.css", path.join(dir, "src/app/x.ts"), compilerOptions).kind, "external");
  } finally {
    cleanup(dir);
  }
});

test("the live scan against the REAL, current V3 repository is clean: no sandbox provider reachable from any real production root", () => {
  const source = readFileSync(path.join(projectRoot, "scripts", "check-no-sandbox-runtime.mjs"), "utf8");
  void source; // sanity: the module under test itself loaded without error (import above would have thrown otherwise).
  const compilerOptions = (() => {
    const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath)).options;
  })();
  const roots = findProductionRoots(srcDir, projectRoot);
  assert.ok(roots.length > 50, "expected many real production roots under src/app and src/config");
  const { violations, scannedCount } = runGraphCheck({ roots, compilerOptions, rootSrcDir: srcDir });
  assert.deepEqual(violations, [], `sandbox-runtime violations found in the real project: ${JSON.stringify(violations, null, 2)}`);
  assert.ok(scannedCount > 100, "expected the real graph traversal to reach a substantial number of modules");
});
