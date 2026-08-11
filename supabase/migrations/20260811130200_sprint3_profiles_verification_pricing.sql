CREATE TYPE "public"."business_profile_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."pricing_plan_kind" AS ENUM('personal', 'business');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."verification_tier" AS ENUM('basic', 'full');--> statement-breakpoint
CREATE TABLE "identity_verification_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_kind" "profile_kind" NOT NULL,
	"profile_id" uuid NOT NULL,
	"tier" "verification_tier" NOT NULL,
	"status" "verification_status" DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"verified_fields" jsonb,
	"reviewer_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_verification_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "pricing_plan_kind" NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"monthly_fee_minor_units" integer,
	"annual_fee_minor_units" integer,
	"per_agreement_fee_minor_units" integer,
	"per_successful_payment_fee_minor_units" integer,
	"free_agreement_allowance" integer,
	"free_included_payments_allowance" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_plan_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "pricing_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_kind" "profile_kind" NOT NULL,
	"profile_id" uuid NOT NULL,
	"pricing_plan_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "display_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "country" text DEFAULT 'US' NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "state" text NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "status" "business_profile_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_verification_record" ADD CONSTRAINT "identity_verification_record_reviewer_user_id_user_account_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_pricing_plan_id_pricing_plan_id_fk" FOREIGN KEY ("pricing_plan_id") REFERENCES "public"."pricing_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md): same RLS
-- lockdown rationale as every prior migration in this project (see
-- 0000_nervous_speedball.sql's comment) — RLS is enabled above with zero
-- permissive policies for anon/authenticated, and this REVOKE is defense in
-- depth against Supabase's default-privilege auto-grants on new
-- public-schema tables.
REVOKE ALL ON "identity_verification_record" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "pricing_plan" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "subscription" FROM anon, authenticated;
