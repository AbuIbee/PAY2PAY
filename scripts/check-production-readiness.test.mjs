import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReadinessReport } from "./check-production-readiness.mjs";

const BASE_ENV = { DATABASE_URL: "postgres://x", AUDIT_HASH_SECRET: "x".repeat(16), AUTH_PASSWORD_PEPPER: "x".repeat(16), APP_URL: "https://paid2you.com", APP_ENV: "production" };

const FULLY_CONFIGURED_ENV = {
  ...BASE_ENV,
  BUSINESS_VERIFICATION_PROVIDER: "middesk",
  MIDDESK_API_KEY: "x",
  MIDDESK_WEBHOOK_SECRET: "y",
  PLATFORM_BILLING_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: "x",
  STRIPE_WEBHOOK_SECRET: "y",
  STRIPE_STARTER_PRICE_ID: "price_starter",
  STRIPE_CORE_PRICE_ID: "price_core",
  STRIPE_GROWTH_PRICE_ID: "price_growth",
  STRIPE_SCALE_PRICE_ID: "price_scale",
  RESEND_API_KEY: "x",
  EMAIL_FROM_ADDRESS: "billing@paid2you.com",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "x",
};

test("FULL_MONEY_MOVEMENT is always DISABLED regardless of any environment variable — Direct Banking is not implemented in this worktree", () => {
  const report = buildReadinessReport({ ...BASE_ENV, STRIPE_SECRET_KEY: "x", PLATFORM_BILLING_PROVIDER: "stripe" });
  assert.equal(report.FULL_MONEY_MOVEMENT, "DISABLED");
});

test("MIDDESK is NOT CONFIGURED without both MIDDESK_API_KEY and MIDDESK_WEBHOOK_SECRET, even with BUSINESS_VERIFICATION_PROVIDER=middesk set", () => {
  const report = buildReadinessReport({ ...BASE_ENV, BUSINESS_VERIFICATION_PROVIDER: "middesk", MIDDESK_API_KEY: "x" });
  assert.equal(report.MIDDESK, "NOT CONFIGURED");
});

test("MIDDESK is CONFIGURED only once the provider is selected AND both secrets are present", () => {
  const report = buildReadinessReport({ ...BASE_ENV, BUSINESS_VERIFICATION_PROVIDER: "middesk", MIDDESK_API_KEY: "x", MIDDESK_WEBHOOK_SECRET: "y" });
  assert.equal(report.MIDDESK, "CONFIGURED");
});

test("STRIPE_BILLING is NOT CONFIGURED when PLATFORM_BILLING_PROVIDER is not 'stripe', even with the secrets present", () => {
  const report = buildReadinessReport({ ...BASE_ENV, STRIPE_SECRET_KEY: "x", STRIPE_WEBHOOK_SECRET: "y" });
  assert.equal(report.STRIPE_BILLING, "NOT CONFIGURED");
});

// --- P0-7 (Codex): the 4 standard Stripe price IDs are required, individually ---
for (const missingPriceVar of ["STRIPE_STARTER_PRICE_ID", "STRIPE_CORE_PRICE_ID", "STRIPE_GROWTH_PRICE_ID", "STRIPE_SCALE_PRICE_ID"]) {
  test(`P0-7: STRIPE_BILLING is NOT CONFIGURED when ${missingPriceVar} is missing, even with the secrets and every other price present`, () => {
    const env = { ...FULLY_CONFIGURED_ENV };
    delete env[missingPriceVar];
    const report = buildReadinessReport(env);
    assert.equal(report.STRIPE_BILLING, "NOT CONFIGURED");
    assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
  });
}

test("P0-7: STRIPE_BILLING is CONFIGURED once secrets AND all 4 standard price IDs are present", () => {
  const report = buildReadinessReport(FULLY_CONFIGURED_ENV);
  assert.equal(report.STRIPE_BILLING, "CONFIGURED");
});

// --- P0-7 (Codex): APP_URL/APP_ENV must be genuinely production-shaped, mirroring env.ts's own rule ---
test("P0-7: BUSINESS_PLATFORM is CONFIGURATION_INCOMPLETE when APP_URL resolves to localhost, even with every other capability fully configured", () => {
  const report = buildReadinessReport({ ...FULLY_CONFIGURED_ENV, APP_URL: "http://localhost:3000" });
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
});

test("P0-7: BUSINESS_PLATFORM is CONFIGURATION_INCOMPLETE when APP_URL resolves to 127.0.0.1", () => {
  const report = buildReadinessReport({ ...FULLY_CONFIGURED_ENV, APP_URL: "http://127.0.0.1:3000" });
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
});

test("P0-7: BUSINESS_PLATFORM is CONFIGURATION_INCOMPLETE when APP_ENV is not 'production', even with a real-looking APP_URL", () => {
  const report = buildReadinessReport({ ...FULLY_CONFIGURED_ENV, APP_ENV: "staging" });
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
});

test("P0-7: BUSINESS_PLATFORM is CONFIGURATION_INCOMPLETE when APP_URL is not a parseable URL at all", () => {
  const report = buildReadinessReport({ ...FULLY_CONFIGURED_ENV, APP_URL: "not-a-url" });
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
});

// --- P0-7 (Codex): RESEND / SUPABASE requirements, and the renamed, non-overstating vocabulary ---
test("P0-7: BUSINESS_PLATFORM is CONFIGURATION_INCOMPLETE when RESEND is not configured", () => {
  const env = { ...FULLY_CONFIGURED_ENV };
  delete env.RESEND_API_KEY;
  const report = buildReadinessReport(env);
  assert.equal(report.RESEND, "NOT CONFIGURED");
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
});

test("P0-7: BUSINESS_PLATFORM is CONFIGURATION_INCOMPLETE when SUPABASE_STORAGE is not configured", () => {
  const env = { ...FULLY_CONFIGURED_ENV };
  delete env.SUPABASE_URL;
  const report = buildReadinessReport(env);
  assert.equal(report.SUPABASE_STORAGE, "NOT CONFIGURED");
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
});

test("BUSINESS_PLATFORM is CONFIGURATION_INCOMPLETE unless every required sub-capability is configured", () => {
  const report = buildReadinessReport(BASE_ENV);
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_INCOMPLETE");
});

test("P0-7: BUSINESS_PLATFORM is CONFIGURATION_READY once database/migrations/middesk/stripe(+4 prices)/resend/supabase/APP_URL/APP_ENV are all genuinely satisfied — but LIVE_VERIFIED always stays NO (configuration presence is never live-provider proof)", () => {
  const report = buildReadinessReport(FULLY_CONFIGURED_ENV);
  assert.equal(report.BUSINESS_PLATFORM, "CONFIGURATION_READY");
  assert.equal(report.LIVE_VERIFIED, "NO");
  assert.equal(report.DATABASE, "READY");
  assert.equal(report.MIGRATIONS, "READY");
});

test("DATABASE is NOT READY when neither DATABASE_URL nor POSTGRES_URL is set", () => {
  const withoutDb = { ...BASE_ENV };
  delete withoutDb.DATABASE_URL;
  const report = buildReadinessReport(withoutDb);
  assert.equal(report.DATABASE, "NOT READY");
});

test("never includes any environment variable VALUE in its output — only the fixed vocabulary (READY/NOT READY/CONFIGURED/NOT CONFIGURED/CONFIGURATION_READY/CONFIGURATION_INCOMPLETE/DISABLED/YES/NO)", () => {
  const secretValue = "sk_live_super_secret_value_never_print_me";
  const report = buildReadinessReport({ ...BASE_ENV, STRIPE_SECRET_KEY: secretValue, PLATFORM_BILLING_PROVIDER: "stripe" });
  assert.ok(!JSON.stringify(report).includes(secretValue));
});
