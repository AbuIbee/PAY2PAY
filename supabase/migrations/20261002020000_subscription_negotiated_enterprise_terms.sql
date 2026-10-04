-- PAID2YOU PLATFORM EXPANSION (2026-10-02), backend-foundations phase, item 3: Enterprise custom
-- contract-price/limit capability (Requirement 23/26, DB-4/DB-5). Organization-specific negotiated
-- terms, deliberately separate columns from pricing_plan's catalog starting/reference price and
-- entitlement limit — never overwrites either. NULL (every Core/Growth/Scale subscription, and any
-- Enterprise subscription before a contract is actually negotiated) means "use the catalog value."
-- See src/db/schema/pricing.ts's own doc comments on these two columns.
ALTER TABLE "subscription" ADD COLUMN "negotiated_monthly_fee_minor_units" integer;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "negotiated_new_arrangements_monthly_limit" integer;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_negotiated_fee_positive" CHECK ("subscription"."negotiated_monthly_fee_minor_units" IS NULL OR "subscription"."negotiated_monthly_fee_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_negotiated_limit_positive" CHECK ("subscription"."negotiated_new_arrangements_monthly_limit" IS NULL OR "subscription"."negotiated_new_arrangements_monthly_limit" > 0);
