-- PAID2YOU PLATFORM EXPANSION (2026-10-02), onboarding/workspace phase: the Business Details
-- onboarding step's required fields this schema didn't already have (DB-2/Requirement 3), plus a
-- step-only resumability marker (Requirement 4/Section 3 — never the activation decision itself;
-- see src/lib/organizations/businessActivationService.ts). Every column is nullable or
-- safely-defaulted — no existing row loses data or becomes invalid.
CREATE TYPE "public"."business_industry" AS ENUM('TRUCKING', 'FREIGHT', 'THREE_PL', 'RETAIL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."business_onboarding_step" AS ENUM('details_pending', 'details_complete', 'verification_submitted', 'tier_selected', 'billing_setup_complete');--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "dba_name" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "industry" "business_industry";--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "formation_jurisdiction" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "business_email" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "representative_first_name" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "representative_last_name" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "representative_title" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "representative_email" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "representative_phone" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "representative_relationship" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "onboarding_step" "business_onboarding_step" DEFAULT 'details_pending' NOT NULL;
