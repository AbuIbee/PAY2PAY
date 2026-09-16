import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findSandboxRuntimeViolations, isExcludedPath, srcDir } from "./check-no-sandbox-runtime.mjs";

test("flags an import of a retired sandbox provider implementation file", () => {
  const text = `import { SandboxPaymentProvider } from "@/test-support/payments/sandboxPaymentProvider";\nexport function getPaymentProvider() { return new SandboxPaymentProvider("x"); }\n`;
  const violations = findSandboxRuntimeViolations(text);
  assert.ok(violations.some((v) => v.rule === "sandbox-provider-import"));
});

test("flags a re-declared SandboxKycProvider/SandboxCardIssuingProvider class outside test-support", () => {
  assert.ok(findSandboxRuntimeViolations("export class SandboxKycProvider implements KycKybProvider {}").some((v) => v.rule === "sandbox-provider-class-declaration"));
  assert.ok(findSandboxRuntimeViolations("export class SandboxCardIssuingProvider implements CardIssuingProvider {}").some((v) => v.rule === "sandbox-provider-class-declaration"));
});

test("flags a reference to the retired /api/admin/sandbox route path", () => {
  const text = `await fetch("/api/admin/sandbox/simulate-settlement", { method: "POST" });`;
  assert.ok(findSandboxRuntimeViolations(text).some((v) => v.rule === "retired-admin-sandbox-route-reference"));
});

test("flags PAYMENT_PROVIDER/KYC_PROVIDER/CARD_ISSUING_PROVIDER literally assigned the string \"sandbox\" in code", () => {
  assert.ok(findSandboxRuntimeViolations('const x = { PAYMENT_PROVIDER: "sandbox" };').some((v) => v.rule === "forbidden-provider-literal-sandbox"));
  assert.ok(findSandboxRuntimeViolations("process.env.KYC_PROVIDER = 'sandbox';").some((v) => v.rule === "forbidden-provider-literal-sandbox"));
});

test("does NOT flag prose doc comments that merely mention the class names or the word 'sandbox' while explaining why it is prohibited", () => {
  const text = `
/**
 * Sandbox/mock provider *implementations* (SandboxPaymentProvider, SandboxKycProvider,
 * SandboxCardIssuingProvider) still exist, but only as test doubles under src/test-support/ — they
 * are never imported from this file, the three getXProvider() factories, or any other production
 * runtime path, and are never registered here. No live provider is configured; PAYMENT_PROVIDER,
 * KYC_PROVIDER, and CARD_ISSUING_PROVIDER never resolve to "sandbox" behavior.
 */
export const PROVIDER_CAPABILITY_REGISTRY = {};
`;
  assert.deepEqual(findSandboxRuntimeViolations(text), []);
});

test("does not flag ordinary, unrelated code with no sandbox reference at all", () => {
  assert.deepEqual(findSandboxRuntimeViolations('import { z } from "zod";\nexport const x = z.string();'), []);
});

test("isExcludedPath excludes src/test-support/**, every *.test.ts(x) file, and every (Tt)estFakes.ts(x) file, includes everything else", () => {
  assert.equal(isExcludedPath("test-support/payments/sandboxPaymentProvider.ts"), true);
  assert.equal(isExcludedPath("lib/payments/sandboxPaymentProvider.test.ts"), true);
  assert.equal(isExcludedPath("components/BankConnectionForm.test.tsx"), true);
  assert.equal(isExcludedPath("lib/payments/testFakes.ts"), true);
  assert.equal(isExcludedPath("lib/kyc/testFakes.ts"), true);
  assert.equal(isExcludedPath("lib/cards/testFakes.ts"), true);
  assert.equal(isExcludedPath("lib/auth/mfaTestFakes.ts"), true);
  assert.equal(isExcludedPath("lib/payments/getPaymentProvider.ts"), false);
  assert.equal(isExcludedPath("lib/providers/providerCapabilities.ts"), false);
});

test("testFakes.ts files legitimately importing the relocated sandbox providers are excluded from the live repo scan", () => {
  assert.equal(isExcludedPath("lib/payments/testFakes.ts"), true);
});

test("the real, current repository is clean: zero sandbox-runtime violations across all non-excluded src/**/*.ts(x) files", () => {
  const files = walk(srcDir);
  const failures = [];
  for (const file of files) {
    const relative = path.relative(srcDir, file);
    if (isExcludedPath(relative)) continue;
    const text = readFileSync(file, "utf8");
    const violations = findSandboxRuntimeViolations(text);
    if (violations.length > 0) failures.push({ file: relative, violations });
  }
  assert.deepEqual(failures, [], `sandbox-runtime violations found: ${JSON.stringify(failures, null, 2)}`);
});

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
