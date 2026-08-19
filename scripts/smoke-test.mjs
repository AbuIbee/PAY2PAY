#!/usr/bin/env node
/**
 * PRSprint 30 (docs/prsprints/PRSPRINT_30_CI_CD_DEPLOYMENT_GATES_SCHEMA_DRIFT_PREVENTION.md), master-
 * spec item 129: "Add smoke tests after deployment ... homepage/login; Supabase connection; create/
 * read basic record; protected route; critical API; provider configuration health."
 *
 * Runs a small set of read-only, non-destructive checks against a deployed URL. Deliberately does
 * NOT attempt "create/read basic record" (signing up a real account, creating an agreement, etc.)
 * against a live deployment — doing that safely needs a dedicated, isolated test-account mechanism
 * this project does not yet have (master-spec item 94, "test accounts must be isolated", is not yet
 * implemented); running real signup/write traffic against production here would itself be the kind
 * of "test account contaminating real data" that item forbids. That check remains a documented,
 * unresolved known limitation — see PRSprint 30's completion report.
 *
 * Usage: SMOKE_TEST_URL=https://your-deployment.example node scripts/smoke-test.mjs
 *    or: node scripts/smoke-test.mjs --url https://your-deployment.example
 *
 * This script only runs the checks; wiring it to fire automatically right after a real deployment
 * (e.g. a Vercel deploy-hook-triggered workflow_dispatch) needs Vercel API credentials this
 * environment does not have — see the `smoke-test` job in .github/workflows/ci.yml (workflow_dispatch,
 * manually triggered with the deployment URL as input) for the CI-side half of this.
 */
import { fileURLToPath } from "node:url";

/** `--url` takes precedence over SMOKE_TEST_URL; trailing slash stripped so path-joining below never double-slashes. Exported for unit testing. */
export function resolveBaseUrl(argv, env) {
  const urlArgIndex = argv.indexOf("--url");
  const raw = (urlArgIndex !== -1 ? argv[urlArgIndex + 1] : undefined) ?? env.SMOKE_TEST_URL;
  return raw ? raw.replace(/\/$/, "") : null;
}

async function runSmokeTests(base) {
  if (!base) {
    console.error("[smoke-test] Provide a deployment URL: --url <url> or SMOKE_TEST_URL=<url>");
    process.exitCode = 1;
    return;
  }

  let failed = false;

  async function check(name, path, expectedStatus, validate) {
    const url = `${base}${path}`;
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status !== expectedStatus) {
        failed = true;
        console.error(`[smoke-test] FAIL ${name}: ${url} returned ${response.status}, expected ${expectedStatus}`);
        return;
      }
      if (validate) {
        const body = await response.json().catch(() => null);
        const problem = validate(body);
        if (problem) {
          failed = true;
          console.error(`[smoke-test] FAIL ${name}: ${problem}`);
          return;
        }
      }
      console.log(`[smoke-test] OK   ${name} (${url} -> ${response.status})`);
    } catch (error) {
      failed = true;
      console.error(`[smoke-test] FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`[smoke-test] Running against ${base}`);

  await check("liveness (/api/health)", "/api/health", 200, (body) => {
    if (!body || body.status !== "ok") return `expected {status: "ok"}, got ${JSON.stringify(body)}`;
    return null;
  });
  await check("homepage", "/", 200);
  await check("login page", "/login", 200);
  // A protected admin route correctly rejecting an unauthenticated caller is itself a meaningful,
  // safe smoke assertion: it proves the auth/authorization middleware is live end-to-end in this
  // deployment, without needing real credentials against production.
  await check("protected route denies unauthenticated access (/api/admin/health)", "/api/admin/health", 401);

  if (failed) {
    console.error("[smoke-test] One or more checks failed.");
    process.exitCode = 1;
  } else {
    console.log("[smoke-test] All checks passed.");
  }
}

// Only run when executed directly (`node scripts/smoke-test.mjs`), not when imported by its own test file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runSmokeTests(resolveBaseUrl(process.argv, process.env));
}
