CREATE TYPE "public"."amendment_change_type" AS ENUM('new_date', 'temporary_pause', 'reduced_installment', 'revised_schedule', 'general');--> statement-breakpoint
CREATE TYPE "public"."amendment_status" AS ENUM('proposed', 'awaiting_signatures', 'signed', 'applied', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TABLE "amendment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"change_type" "amendment_change_type" NOT NULL,
	"status" "amendment_status" DEFAULT 'proposed' NOT NULL,
	"proposing_party_role" "agreement_party_role" NOT NULL,
	"proposed_by_profile_kind" "profile_kind" NOT NULL,
	"proposed_by_profile_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"requested_relief" text,
	"proposed_effective_date" date,
	"frequency" "payment_frequency" NOT NULL,
	"fee_allocation" "fee_allocation" NOT NULL,
	"terms" jsonb NOT NULL,
	"creditor_signed_at" timestamp with time zone,
	"debtor_signed_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"resulting_version_id" uuid,
	"rejected_reason" text,
	"rejected_at" timestamp with time zone,
	"withdrawn_reason" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "amendment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "amendment" ADD CONSTRAINT "amendment_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment" ADD CONSTRAINT "amendment_resulting_version_id_agreement_version_id_fk" FOREIGN KEY ("resulting_version_id") REFERENCES "public"."agreement_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Sprint 14 (docs/sprints/SPRINT_14_Amendments_Hardship.md): same RLS lockdown rationale as every
-- prior migration in this project (see 0000_nervous_speedball.sql's comment) — RLS is enabled above
-- with zero permissive policies for anon/authenticated, and this REVOKE is defense in depth against
-- Supabase's default-privilege auto-grants on new public-schema tables.
REVOKE ALL ON "amendment" FROM anon, authenticated;