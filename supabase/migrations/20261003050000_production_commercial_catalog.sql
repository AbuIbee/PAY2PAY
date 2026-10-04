-- "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 1, Section 3/9: the canonical Business pricing
-- catalog (src/lib/pricing/seedCanonicalBusinessPlans.ts is the source-of-truth definition this
-- mirrors) had NO production seeding path before this migration — `seedCanonicalBusinessPlans()` was
-- called only from a test harness (businessOnboardingTestHarness.ts), never from any production code
-- path or prior migration. Without this, a freshly-deployed production database has an empty
-- pricing_plan table and the onboarding Tier Selection step (GET /api/organizations/onboarding/plans)
-- would return zero plans — a launch blocker. Idempotent: ON CONFLICT DO NOTHING on the unique `code`/
-- (pricing_plan_id, feature_key) constraints, safe to apply to a database that already has these rows
-- (e.g. one seeded by the test harness during development).
INSERT INTO "pricing_plan" ("kind", "code", "name", "monthly_fee_minor_units", "is_active")
VALUES
  ('business', 'paid2you_business_starter', 'Starter', 9900, true),
  ('business', 'paid2you_business_core', 'Core', 19900, true),
  ('business', 'paid2you_business_growth', 'Growth', 69900, true),
  ('business', 'paid2you_business_scale', 'Scale', 199900, true),
  ('business', 'paid2you_business_enterprise', 'Enterprise', 500000, true)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

INSERT INTO "pricing_plan_entitlement" ("pricing_plan_id", "feature_key", "enabled", "limit_value")
SELECT "id", 'organization_agreements', true, NULL FROM "pricing_plan" WHERE "code" IN (
  'paid2you_business_starter', 'paid2you_business_core', 'paid2you_business_growth', 'paid2you_business_scale', 'paid2you_business_enterprise'
)
ON CONFLICT ("pricing_plan_id", "feature_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "pricing_plan_entitlement" ("pricing_plan_id", "feature_key", "enabled", "limit_value")
SELECT "id", 'new_arrangements_monthly', true,
  CASE "code"
    WHEN 'paid2you_business_starter' THEN 24
    WHEN 'paid2you_business_core' THEN 99
    WHEN 'paid2you_business_growth' THEN 499
    WHEN 'paid2you_business_scale' THEN 1999
    WHEN 'paid2you_business_enterprise' THEN NULL
  END
FROM "pricing_plan" WHERE "code" IN (
  'paid2you_business_starter', 'paid2you_business_core', 'paid2you_business_growth', 'paid2you_business_scale', 'paid2you_business_enterprise'
)
ON CONFLICT ("pricing_plan_id", "feature_key") DO NOTHING;
