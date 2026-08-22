-- PRSprint 32 (docs/prsprints/PRSPRINT_32_COMPLIANCE_HOOKS_CONSENT_PRIVACY_RETENTION.md): generic,
-- append-only consent-capture table (master-spec items 99-100 — "versioned Terms/Privacy/e-
-- communications/SMS consent hooks" and "store consent version/actor/time/method"). Never updated or
-- deleted — the same immutable-historical-artifact discipline as retention_hold/audit_event. RLS
-- enabled with zero CREATE POLICY statements (deny-all for anon/authenticated), matching every other
-- table in this schema (PRSprint 02's established precedent — the app's own DB connection queries as
-- table owner and bypasses RLS regardless). REVOKE added by hand, matching every prior migration.
CREATE TYPE "public"."consent_policy_type" AS ENUM('terms_of_service', 'privacy_policy', 'electronic_communications_consent', 'sms_consent');--> statement-breakpoint
CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"policy_type" "consent_policy_type" NOT NULL,
	"policy_version" text NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"ip_address" text
);
--> statement-breakpoint
ALTER TABLE "consent_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON TABLE "consent_record" FROM anon, authenticated;
