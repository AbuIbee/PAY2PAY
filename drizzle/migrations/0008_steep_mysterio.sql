CREATE TYPE "public"."evidence_document_type" AS ENUM('invoice', 'receipt', 'contract', 'estimate', 'purchase_order', 'proof_of_delivery', 'proof_of_completed_work', 'prior_payment_record', 'other');--> statement-breakpoint
CREATE TYPE "public"."evidence_file_validation_status" AS ENUM('pending', 'clean', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."evidence_visibility" AS ENUM('shared', 'private');--> statement-breakpoint
CREATE TYPE "public"."evidence_withdrawal_state" AS ENUM('active', 'withdrawn');--> statement-breakpoint
CREATE TABLE "agreement_witness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"witness_user_id" uuid NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attested_version_id" uuid,
	"attested_at" timestamp with time zone,
	"ip_address" text,
	"device_info" jsonb
);
--> statement-breakpoint
ALTER TABLE "agreement_witness" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "evidence_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"document_type" "evidence_document_type" NOT NULL,
	"description" text,
	"storage_path" text NOT NULL,
	"document_hash" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"is_post_signing" boolean DEFAULT false NOT NULL,
	"visibility" "evidence_visibility" DEFAULT 'shared' NOT NULL,
	"shared_with_witnesses" boolean DEFAULT false NOT NULL,
	"dispute_flag" boolean DEFAULT false NOT NULL,
	"withdrawal_state" "evidence_withdrawal_state" DEFAULT 'active' NOT NULL,
	"file_validation_status" "evidence_file_validation_status" DEFAULT 'clean' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement_witness" ADD CONSTRAINT "agreement_witness_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_witness" ADD CONSTRAINT "agreement_witness_witness_user_id_user_account_id_fk" FOREIGN KEY ("witness_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_witness" ADD CONSTRAINT "agreement_witness_added_by_user_id_user_account_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_witness" ADD CONSTRAINT "agreement_witness_attested_version_id_agreement_version_id_fk" FOREIGN KEY ("attested_version_id") REFERENCES "public"."agreement_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_document" ADD CONSTRAINT "evidence_document_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_document" ADD CONSTRAINT "evidence_document_uploaded_by_user_id_user_account_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_witness_agreement_user_unique" ON "agreement_witness" USING btree ("agreement_id","witness_user_id");--> statement-breakpoint
-- Sprint 7 (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md): same RLS
-- lockdown rationale as every prior migration in this project (see
-- 0000_nervous_speedball.sql's comment) — RLS is enabled above with zero
-- permissive policies for anon/authenticated, and this REVOKE is defense in
-- depth against Supabase's default-privilege auto-grants on new
-- public-schema tables.
REVOKE ALL ON "agreement_witness" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "evidence_document" FROM anon, authenticated;