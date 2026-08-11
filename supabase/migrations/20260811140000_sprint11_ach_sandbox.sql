CREATE TYPE "public"."ach_mandate_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE 'scheduled';--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE 'submitted';--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE 'processing';--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE 'returned';--> statement-breakpoint
CREATE TABLE "ach_mandate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"payer_profile_kind" "profile_kind" NOT NULL,
	"payer_profile_id" uuid NOT NULL,
	"bank_account_ref" text NOT NULL,
	"status" "ach_mandate_status" DEFAULT 'active' NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"supersedes_mandate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ach_mandate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "payout_initiated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "installment_schedule_item_id" uuid;--> statement-breakpoint
ALTER TABLE "ach_mandate" ADD CONSTRAINT "ach_mandate_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_installment_schedule_item_id_installment_schedule_item_id_fk" FOREIGN KEY ("installment_schedule_item_id") REFERENCES "public"."installment_schedule_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md): same RLS lockdown rationale as every prior
-- migration in this project (see 0000_nervous_speedball.sql's comment) — RLS is enabled above with
-- zero permissive policies for anon/authenticated, and this REVOKE is defense in depth against
-- Supabase's default-privilege auto-grants on new public-schema tables.
REVOKE ALL ON "ach_mandate" FROM anon, authenticated;
