CREATE TYPE "public"."signing_authority" AS ENUM('account_owner', 'authorized_representative');--> statement-breakpoint
CREATE TABLE "agreement_pdf" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"document_hash" text NOT NULL,
	"payment_authorization_ref" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_pdf" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "signature_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"signer_user_id" uuid NOT NULL,
	"signer_profile_kind" "profile_kind" NOT NULL,
	"signer_profile_id" uuid NOT NULL,
	"signer_role" "agreement_party_role" NOT NULL,
	"signing_authority" "signing_authority",
	"signer_title" text,
	"consent_captured" boolean NOT NULL,
	"consent_version" text NOT NULL,
	"auth_method" "mfa_method" NOT NULL,
	"ip_address" text NOT NULL,
	"device_info" jsonb,
	"timezone" text NOT NULL,
	"agreement_hash_at_signing" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signature_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement_pdf" ADD CONSTRAINT "agreement_pdf_agreement_version_id_agreement_version_id_fk" FOREIGN KEY ("agreement_version_id") REFERENCES "public"."agreement_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_event" ADD CONSTRAINT "signature_event_agreement_version_id_agreement_version_id_fk" FOREIGN KEY ("agreement_version_id") REFERENCES "public"."agreement_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_event" ADD CONSTRAINT "signature_event_signer_user_id_user_account_id_fk" FOREIGN KEY ("signer_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_pdf_version_unique" ON "agreement_pdf" USING btree ("agreement_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_event_version_role_unique" ON "signature_event" USING btree ("agreement_version_id","signer_role");--> statement-breakpoint
-- Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): same RLS
-- lockdown rationale as every prior migration in this project (see
-- 0000_nervous_speedball.sql's comment) — RLS is enabled above with zero
-- permissive policies for anon/authenticated, and this REVOKE is defense in
-- depth against Supabase's default-privilege auto-grants on new
-- public-schema tables.
REVOKE ALL ON "agreement_pdf" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "signature_event" FROM anon, authenticated;