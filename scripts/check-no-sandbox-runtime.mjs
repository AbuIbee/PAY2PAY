#!/usr/bin/env node
/**
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION, requirement #12: a CI regression gate that fails if
 * sandbox financial/KYC/card-issuing provider functionality is ever reintroduced into application
 * runtime source. Pure static text scanning — no database connection, no external credentials, runs
 * on every push/PR via `npm run test:tooling` (this file's own *.test.mjs is picked up by that glob)
 * and directly via `npm run check-no-sandbox-runtime` (CI's own dedicated step).
 *
 * Deliberately NOT a blind grep for the English word "sandbox" — that word legitimately appears in
 * historical documentation, sprint/PRSprint names, remediation reports, and this codebase's own
 * doc comments explaining WHY sandbox is prohibited (including the ones this very remediation added).
 * Blindly rejecting the word would make this script unmaintainable and would not even target the
 * actual risk. Instead this looks for the specific CODE CONSTRUCTS that would reintroduce real
 * runtime capability:
 *
 *   - an import/require whose module specifier resolves to one of the retired sandbox provider
 *     implementation files (sandboxPaymentProvider / sandboxKycProvider / sandboxCardIssuingProvider /
 *     sandboxBusinessVerificationProvider / sandboxPlatformBillingProvider — the latter two added for
 *     "PAID2YOU PRODUCTION LAUNCH", Phase 1, Section 10, covering the B2B organization-workspace
 *     sandbox providers the same way), from any file OUTSIDE src/test-support/ (their sanctioned
 *     test-only home) or a *.test.ts(x) file
 *   - a re-declaration of a class literally named SandboxPaymentProvider/SandboxKycProvider/
 *     SandboxCardIssuingProvider/SandboxBusinessVerificationProvider/SandboxPlatformBillingProvider
 *     outside src/test-support/
 *   - any reference to the retired /api/admin/sandbox route path
 *   - the literal env-var value "sandbox" being assigned to PAYMENT_PROVIDER/KYC_PROVIDER/
 *     CARD_ISSUING_PROVIDER inside application source (as opposed to a *.test.ts fixture, which is
 *     legitimately allowed to assert that value is REJECTED)
 *
 * Scans every .ts/.tsx file under src/, excluding *.test.ts(x) and src/test-support/**.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const srcDir = path.join(__dirname, "..", "src");

const SANDBOX_MODULE_SPECIFIER_PATTERN = /sandbox(?:Payment|Kyc|CardIssuing|BusinessVerification|PlatformBilling)Provider/;
const SANDBOX_CLASS_DECLARATION_PATTERN = /\bclass\s+Sandbox(?:PaymentProvider|KycProvider|CardIssuingProvider|BusinessVerificationProvider|PlatformBillingProvider)\b/;
const RETIRED_ADMIN_SANDBOX_ROUTE_PATTERN = /\/api\/admin\/sandbox\b/;
/** Matches PAYMENT_PROVIDER="sandbox" style literal assignment/property patterns actually written as CODE (not prose) — quoted "sandbox" immediately after one of the three provider env-var names. */
const FORBIDDEN_PROVIDER_LITERAL_PATTERN = /(PAYMENT_PROVIDER|KYC_PROVIDER|CARD_ISSUING_PROVIDER)\s*[:=]\s*["']sandbox["']/;

export function isExcludedPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized.startsWith("test-support/")) return true;
  if (/\.test\.tsx?$/.test(normalized)) return true;
  // This codebase's established, repo-wide convention for a colocated test-only double file — e.g.
  // src/lib/payments/testFakes.ts, src/lib/auth/mfaTestFakes.ts,
  // src/lib/agreements/agreementCancellationTestFakes.ts — always ending in (Tt)estFakes.ts(x), never
  // imported by any route/page/other production module, only by *.test.ts(x) files. Confirmed for the
  // three sandbox-adjacent ones specifically: payments/testFakes.ts, kyc/testFakes.ts,
  // cards/testFakes.ts legitimately import the relocated src/test-support/ sandbox provider classes to
  // construct them as constructor-injected test doubles — see each file's own module doc comment.
  if (/[Tt]est[Ff]akes\.tsx?$/.test(normalized)) return true;
  return false;
}

/** Exported for unit testing without touching the filesystem. Returns a list of {rule, match} violations, empty when clean. */
export function findSandboxRuntimeViolations(fileText) {
  const violations = [];
  if (SANDBOX_MODULE_SPECIFIER_PATTERN.test(fileText) && /\bimport\b|\brequire\(/.test(fileText)) {
    // Narrow the module-specifier check to an actual import/require statement, not just the bare
    // identifier appearing in a doc comment (which every provider-factory file's own explanatory
    // comment legitimately does, post-B0-D-remediation).
    const importLines = fileText
      .split("\n")
      .filter((line) => /\bimport\b.*sandbox(?:Payment|Kyc|CardIssuing|BusinessVerification|PlatformBilling)Provider/i.test(line) || /require\(.*sandbox(?:Payment|Kyc|CardIssuing|BusinessVerification|PlatformBilling)Provider/i.test(line));
    if (importLines.length > 0) violations.push({ rule: "sandbox-provider-import", detail: importLines[0].trim() });
  }
  if (SANDBOX_CLASS_DECLARATION_PATTERN.test(fileText)) {
    violations.push({ rule: "sandbox-provider-class-declaration", detail: fileText.match(SANDBOX_CLASS_DECLARATION_PATTERN)[0] });
  }
  if (RETIRED_ADMIN_SANDBOX_ROUTE_PATTERN.test(fileText)) {
    violations.push({ rule: "retired-admin-sandbox-route-reference", detail: fileText.match(RETIRED_ADMIN_SANDBOX_ROUTE_PATTERN)[0] });
  }
  if (FORBIDDEN_PROVIDER_LITERAL_PATTERN.test(fileText)) {
    violations.push({ rule: "forbidden-provider-literal-sandbox", detail: fileText.match(FORBIDDEN_PROVIDER_LITERAL_PATTERN)[0] });
  }
  return violations;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const files = walk(srcDir);
  let failed = false;
  let scanned = 0;

  for (const file of files) {
    const relative = path.relative(srcDir, file);
    if (isExcludedPath(relative)) continue;
    scanned += 1;
    const text = readFileSync(file, "utf8");
    const violations = findSandboxRuntimeViolations(text);
    if (violations.length > 0) {
      failed = true;
      for (const violation of violations) {
        console.error(`[no-sandbox-runtime] src/${relative.split(path.sep).join("/")}: ${violation.rule} — ${violation.detail}`);
      }
    }
  }

  if (failed) {
    console.error(
      "[no-sandbox-runtime] FAILED — sandbox/mock financial provider functionality has been reintroduced into application " +
        "runtime source (see docs/PRODUCTION_PROVIDER_READINESS.md and the B0-D TOTAL SANDBOX ELIMINATION remediation). " +
        "Sandbox provider implementations may exist ONLY under src/test-support/ and be imported ONLY from *.test.ts(x) files.",
    );
    process.exitCode = 1;
  } else {
    console.log(`[no-sandbox-runtime] OK — no sandbox provider runtime references found across ${scanned} application source file(s).`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
