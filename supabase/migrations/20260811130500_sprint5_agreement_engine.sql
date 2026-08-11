CREATE TYPE "public"."agreement_party_role" AS ENUM('creditor', 'debtor');--> statement-breakpoint
CREATE TYPE "public"."agreement_status" AS ENUM('draft', 'awaiting_debtor_acknowledgment', 'awaiting_creditor_acceptance', 'awaiting_signatures', 'signed', 'first_payment_pending', 'active', 'past_due', 'disputed', 'paused_by_amendment', 'paid_in_full', 'settled_in_full', 'mutually_canceled', 'closed');--> statement-breakpoint
CREATE TYPE "public"."fee_allocation" AS ENUM('creditor_pays', 'debtor_pays', 'split_evenly');--> statement-breakpoint
CREATE TYPE "public"."installment_item_status" AS ENUM('scheduled', 'paid', 'past_due', 'waived');--> statement-breakpoint
CREATE TYPE "public"."payment_frequency" AS ENUM('weekly', 'biweekly', 'monthly');--> statement-breakpoint
CREATE TABLE "agreement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creditor_profile_kind" "profile_kind" NOT NULL,
	"creditor_profile_id" uuid NOT NULL,
	"debtor_profile_kind" "profile_kind" NOT NULL,
	"debtor_profile_id" uuid NOT NULL,
	"status" "agreement_status" DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"current_version_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agreement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agreement_party" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"role" "agreement_party_role" NOT NULL,
	"profile_kind" "profile_kind" NOT NULL,
	"profile_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_party" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agreement_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"parent_version_id" uuid,
	"is_original" boolean DEFAULT true NOT NULL,
	"produced_by" text NOT NULL,
	"frequency" "payment_frequency" NOT NULL,
	"fee_allocation" "fee_allocation" NOT NULL,
	"terms" jsonb NOT NULL,
	"document_hash" text,
	"creditor_signed_at" timestamp with time zone,
	"debtor_signed_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "installment_schedule_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"status" "installment_item_status" DEFAULT 'scheduled' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installment_schedule_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_created_by_user_id_user_account_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_party" ADD CONSTRAINT "agreement_party_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_version" ADD CONSTRAINT "agreement_version_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_schedule_item" ADD CONSTRAINT "installment_schedule_item_agreement_version_id_agreement_version_id_fk" FOREIGN KEY ("agreement_version_id") REFERENCES "public"."agreement_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_party_agreement_role_unique" ON "agreement_party" USING btree ("agreement_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_version_agreement_number_unique" ON "agreement_version" USING btree ("agreement_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_schedule_item_version_sequence_unique" ON "installment_schedule_item" USING btree ("agreement_version_id","sequence_number");--> statement-breakpoint
-- Sprint 5 (docs/sprints/SPRINT_05_Agreement_Engine.md): same RLS
-- lockdown rationale as every prior migration in this project (see
-- 0000_nervous_speedball.sql's comment) — RLS is enabled above with zero
-- permissive policies for anon/authenticated, and this REVOKE is defense in
-- depth against Supabase's default-privilege auto-grants on new
-- public-schema tables.
REVOKE ALL ON "agreement" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "agreement_party" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "agreement_version" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "installment_schedule_item" FROM anon, authenticated;
