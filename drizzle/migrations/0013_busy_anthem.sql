CREATE TYPE "public"."debit_card_method_status" AS ENUM('active', 'replaced', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('ach', 'debit_card');--> statement-breakpoint
CREATE TABLE "debit_card_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"payer_profile_kind" "profile_kind" NOT NULL,
	"payer_profile_id" uuid NOT NULL,
	"card_token" text NOT NULL,
	"card_last4" text NOT NULL,
	"card_brand" text,
	"expires_at_month" integer NOT NULL,
	"expires_at_year" integer NOT NULL,
	"status" "debit_card_method_status" DEFAULT 'active' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone,
	"replaced_reason" text,
	"supersedes_card_method_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "debit_card_method" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "payment_method" "payment_method";--> statement-breakpoint
ALTER TABLE "debit_card_method" ADD CONSTRAINT "debit_card_method_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md): same RLS lockdown rationale as every
-- prior migration in this project (see 0000_nervous_speedball.sql's comment) — RLS is enabled above
-- with zero permissive policies for anon/authenticated, and this REVOKE is defense in depth against
-- Supabase's default-privilege auto-grants on new public-schema tables.
REVOKE ALL ON "debit_card_method" FROM anon, authenticated;