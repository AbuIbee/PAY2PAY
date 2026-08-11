CREATE TYPE "public"."agreement_reference_type" AS ENUM('invoice', 'purchase_order', 'contract');--> statement-breakpoint
CREATE TYPE "public"."csv_import_batch_status" AS ENUM('uploaded', 'validated', 'drafts_created');--> statement-breakpoint
CREATE TYPE "public"."csv_import_row_duplicate_status" AS ENUM('unique', 'duplicate_in_file', 'duplicate_existing_agreement');--> statement-breakpoint
CREATE TYPE "public"."csv_import_row_validation_status" AS ENUM('pending', 'valid', 'invalid');--> statement-breakpoint
CREATE TABLE "agreement_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"reference_type" "agreement_reference_type" NOT NULL,
	"reference_number" text NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_reference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "csv_import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"status" "csv_import_batch_status" DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "csv_import_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "csv_import_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"customer_email" text NOT NULL,
	"customer_name" text NOT NULL,
	"invoice_reference" text,
	"balance_minor_units" integer NOT NULL,
	"proposed_installment_amount_minor_units" integer NOT NULL,
	"proposed_frequency" "payment_frequency" NOT NULL,
	"proposed_first_payment_date" date NOT NULL,
	"validation_status" "csv_import_row_validation_status" DEFAULT 'pending' NOT NULL,
	"validation_errors" jsonb,
	"duplicate_status" "csv_import_row_duplicate_status" DEFAULT 'unique' NOT NULL,
	"created_draft_agreement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "csv_import_row" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement_reference" ADD CONSTRAINT "agreement_reference_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_reference" ADD CONSTRAINT "agreement_reference_added_by_user_id_user_account_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_batch" ADD CONSTRAINT "csv_import_batch_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_batch" ADD CONSTRAINT "csv_import_batch_uploaded_by_user_id_user_account_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_row" ADD CONSTRAINT "csv_import_row_batch_id_csv_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."csv_import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_row" ADD CONSTRAINT "csv_import_row_created_draft_agreement_id_agreement_id_fk" FOREIGN KEY ("created_draft_agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md): same RLS
-- lockdown rationale as every prior migration in this project (see
-- 0000_nervous_speedball.sql's comment) — RLS is enabled above with zero
-- permissive policies for anon/authenticated, and this REVOKE is defense in
-- depth against Supabase's default-privilege auto-grants on new
-- public-schema tables.
REVOKE ALL ON "agreement_reference" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "csv_import_batch" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "csv_import_row" FROM anon, authenticated;
