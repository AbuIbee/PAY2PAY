-- SPRINT_19_FraudRisk_SecurityHardening: internal fraud/risk signal ledger (master-spec §12/§13).
-- Append-only (same immutable-historical-artifact discipline as audit_event/consent_record) — a
-- later admin review never rewrites what was actually observed, only adds a review decision on top
-- via review_state/reviewed_by_user_id/reviewed_at. RLS enabled with zero CREATE POLICY statements
-- (deny-all for anon/authenticated), matching every other table in this schema (PRSprint 02's
-- established precedent — the app's own DB connection queries as table owner and bypasses RLS
-- regardless). REVOKE added by hand, matching every prior migration. Deliberately minimal `detail`
-- payload — small, already-derived counters only, never a raw IP/device fingerprint (see
-- src/db/schema/riskSignal.ts's own doc comment for the full rationale).
CREATE TYPE "public"."risk_signal_outcome" AS ENUM('flagged', 'challenge_recommended', 'manual_review_recommended');--> statement-breakpoint
CREATE TYPE "public"."risk_signal_review_state" AS ENUM('open', 'reviewed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."risk_signal_severity" AS ENUM('info', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."risk_signal_type" AS ENUM('repeated_authentication_failure', 'repeated_payment_failure', 'frequent_bank_connection_change', 'high_value_action_new_account', 'invitation_velocity', 'unusual_admin_activity');--> statement-breakpoint
CREATE TABLE "risk_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"signal_type" "risk_signal_type" NOT NULL,
	"severity" "risk_signal_severity" NOT NULL,
	"outcome" "risk_signal_outcome" NOT NULL,
	"related_resource_type" text,
	"related_resource_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_state" "risk_signal_review_state" DEFAULT 'open' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "risk_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_reviewed_by_user_id_user_account_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON TABLE "risk_event" FROM anon, authenticated;
