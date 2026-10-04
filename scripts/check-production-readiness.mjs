#!/usr/bin/env node
/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 46/47/67/68: a safe, operator-facing readiness
 * report. Reads only environment variable NAMES/presence from `process.env` — never a value, never
 * printed, never logged. Distinguishes the vocabulary this order requires (Section 68):
 *
 *   - CONFIGURED   = the required environment variable(s) for this capability are present.
 *   - NOT CONFIGURED = one or more required variables are missing.
 *
 * This script NEVER claims LIVE VERIFIED — presence of a variable proves configuration exists, not
 * that a live call against that provider has ever succeeded (Section 69: "Middesk adapter built"
 * does not equal "Middesk live verified"). It also never attempts a network call against any
 * provider (Middesk/Stripe/Resend/Supabase) — only `DATABASE_URL`'s own structural shape is checked,
 * and even that is a connection-string-shape check, not a live `SELECT 1`.
 *
 * Usage: `npm run production-readiness` (or `node scripts/check-production-readiness.mjs`).
 * Exit code 0 always (this is a report, not a CI gate) — a human/operator reads the output before
 * Days 4-5 begin; a future CI gate can inspect the printed JSON if that is ever wanted.
 */
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { findDestructivePatterns, KNOWN_HISTORICAL_EXCEPTIONS, migrationsDir } from "./check-migration-safety.mjs";

/** Reuses check-migration-safety.mjs's own exact scan (never a second, divergent destructive-statement pattern set) — repository-level only, never a claim about a live deployed database's actual applied state (see this file's own module doc comment). */
function migrationsStaticallySafe() {
  let files;
  try {
    files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  } catch {
    return false;
  }
  if (files.length === 0) return false;
  return files.every((file) => KNOWN_HISTORICAL_EXCEPTIONS.has(file) || findDestructivePatterns(readFileSync(path.join(migrationsDir, file), "utf8")).length === 0);
}

/**
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-7: mirrors
 * `src/config/env.ts`'s own production `APP_URL` superRefine rule verbatim (same three hostname
 * literals, same "APP_ENV=production + localhost APP_URL is invalid" judgment) — never a second,
 * looser definition of "production-shaped URL". Deliberately duplicated rather than imported: this
 * script runs under plain `node` (no TypeScript/path-alias loader), while `env.ts` is a `server-only`
 * TypeScript module; re-deriving the identical check inline is safer than wiring a build step into a
 * read-only reporting script just to share three string comparisons.
 */
function isProductionShapedAppUrl(appUrl) {
  if (!appUrl) return false;
  let hostname;
  try {
    hostname = new URL(appUrl).hostname;
  } catch {
    return false;
  }
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return !isLocalhost;
}

export function buildReadinessReport(env) {
  const databaseReady = Boolean(env.DATABASE_URL || env.POSTGRES_URL);
  const migrationsReady = databaseReady && migrationsStaticallySafe();

  const middeskConfigured = env.BUSINESS_VERIFICATION_PROVIDER === "middesk" && Boolean(env.MIDDESK_API_KEY) && Boolean(env.MIDDESK_WEBHOOK_SECRET);
  // P0-7: the 4 standard-plan Stripe Price IDs are REQUIRED for BUSINESS_PLATFORM readiness — without
  // them, `StripePlatformBillingProvider.requirePriceId` throws `ConfigurationError` for every
  // standard plan the moment a real Business tries to start/change a subscription, even though the
  // provider "secret key + webhook secret" pair alone made this report previously claim CONFIGURED.
  const stripeConfigured =
    env.PLATFORM_BILLING_PROVIDER === "stripe" &&
    Boolean(env.STRIPE_SECRET_KEY) &&
    Boolean(env.STRIPE_WEBHOOK_SECRET) &&
    Boolean(env.STRIPE_STARTER_PRICE_ID) &&
    Boolean(env.STRIPE_CORE_PRICE_ID) &&
    Boolean(env.STRIPE_GROWTH_PRICE_ID) &&
    Boolean(env.STRIPE_SCALE_PRICE_ID);
  const resendConfigured = Boolean(env.RESEND_API_KEY) && Boolean(env.EMAIL_FROM_ADDRESS);
  const supabaseStorageConfigured = Boolean(env.SUPABASE_URL) && Boolean(env.SUPABASE_SERVICE_ROLE_KEY);

  // P0-7: APP_URL presence alone (the prior check) is not enough — a localhost APP_URL with
  // APP_ENV=production is a structurally invalid, runtime-rejected configuration (env.ts's own
  // superRefine throws `EnvironmentValidationError` for exactly this), so it must never read as
  // "ready" here either.
  const appUrlProductionShaped = isProductionShapedAppUrl(env.APP_URL);
  const businessPlatformBootRequired =
    Boolean(env.DATABASE_URL || env.POSTGRES_URL) &&
    Boolean(env.AUDIT_HASH_SECRET) &&
    Boolean(env.AUTH_PASSWORD_PEPPER) &&
    appUrlProductionShaped &&
    env.APP_ENV === "production";
  const businessPlatformConfigComplete = businessPlatformBootRequired && migrationsReady && middeskConfigured && stripeConfigured && resendConfigured && supabaseStorageConfigured;

  return {
    DATABASE: databaseReady ? "READY" : "NOT READY",
    MIGRATIONS: migrationsReady ? "READY" : "NOT READY",
    MIDDESK: middeskConfigured ? "CONFIGURED" : "NOT CONFIGURED",
    STRIPE_BILLING: stripeConfigured ? "CONFIGURED" : "NOT CONFIGURED",
    RESEND: resendConfigured ? "CONFIGURED" : "NOT CONFIGURED",
    SUPABASE_STORAGE: supabaseStorageConfigured ? "CONFIGURED" : "NOT CONFIGURED",
    // "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-7: renamed from the prior bare
    // "READY"/"NOT READY" — configuration PRESENCE is not the same claim as LAUNCH READY, and the
    // prior vocabulary was read (correctly, by Codex) as overstating exactly that. This value means
    // ONLY "every required environment variable for this capability is present and structurally
    // valid" — never that a live call against any provider has ever succeeded. See LIVE_VERIFIED
    // below, and docs/PRODUCTION_LAUNCH_RUNBOOK.md's own vocabulary section.
    BUSINESS_PLATFORM: businessPlatformConfigComplete ? "CONFIGURATION_READY" : "CONFIGURATION_INCOMPLETE",
    // This script makes zero network calls to any provider (see this file's own module doc comment) —
    // it can never itself produce LIVE_VERIFIED=YES. Only an actual successful production
    // smoke-test/first-live-Business exercise (docs/FIRST_LIVE_BUSINESS_ACCEPTANCE.md) can.
    LIVE_VERIFIED: "NO",
    // Section 48: never implemented in this worktree — always DISABLED, regardless of any
    // environment variable, until Direct Banking Connectivity (Phase 3B) is independently built and
    // approved. Never computed from, or confused with, BUSINESS_PLATFORM's own readiness.
    FULL_MONEY_MOVEMENT: "DISABLED",
  };
}

function printReport(report) {
  console.log("[production-readiness] CODE-COMPLETE vs. CONFIGURED vs. LIVE VERIFIED are distinct — see docs/PRODUCTION_LAUNCH_RUNBOOK.md's own vocabulary section. This report proves CONFIGURATION PRESENCE only.");
  for (const [key, value] of Object.entries(report)) {
    console.log(`[production-readiness] ${key}: ${value}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  printReport(buildReadinessReport(process.env));
}
