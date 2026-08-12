CREATE TYPE "public"."agreement_dispute_category" AS ENUM('debt_does_not_exist', 'incorrect_amount', 'evidence_challenged', 'administration_challenged', 'other');--> statement-breakpoint
CREATE TYPE "public"."agreement_dispute_status" AS ENUM('opened', 'under_review', 'resolved_no_change', 'resolved_with_amendment', 'restricted', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payment_dispute_category" AS ENUM('unauthorized_ach', 'unauthorized_debit_card', 'processor_dispute');--> statement-breakpoint
CREATE TYPE "public"."payment_dispute_status" AS ENUM('claimed', 'upheld', 'denied');--> statement-breakpoint
CREATE TABLE "agreement_dispute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"status" "agreement_dispute_status" DEFAULT 'opened' NOT NULL,
	"category" "agreement_dispute_category" NOT NULL,
	"explanation" text NOT NULL,
	"raised_by_role" "agreement_party_role" NOT NULL,
	"raised_by_profile_kind" "profile_kind" NOT NULL,
	"raised_by_profile_id" uuid NOT NULL,
	"raised_by_user_id" uuid NOT NULL,
	"response" text,
	"responded_by_user_id" uuid,
	"responded_at" timestamp with time zone,
	"resolution_notes" text,
	"resolved_at" timestamp with time zone,
	"resulting_amendment_id" uuid,
	"restricted_reason" text,
	"restricted_by_user_id" uuid,
	"restricted_at" timestamp with time zone,
	"restriction_lifted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_dispute" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_dispute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"status" "payment_dispute_status" DEFAULT 'claimed' NOT NULL,
	"category" "payment_dispute_category" NOT NULL,
	"explanation" text NOT NULL,
	"claimed_by_profile_kind" "profile_kind" NOT NULL,
	"claimed_by_profile_id" uuid NOT NULL,
	"claimed_by_user_id" uuid NOT NULL,
	"preserved_mandate_reference" text,
	"preserved_signature_reference" text,
	"preserved_identity_verification_reference" text,
	"ip_address" text,
	"device_info" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution_notes" text,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_dispute" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement_dispute" ADD CONSTRAINT "agreement_dispute_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_dispute" ADD CONSTRAINT "agreement_dispute_raised_by_user_id_user_account_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_dispute" ADD CONSTRAINT "agreement_dispute_responded_by_user_id_user_account_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_dispute" ADD CONSTRAINT "agreement_dispute_resulting_amendment_id_amendment_id_fk" FOREIGN KEY ("resulting_amendment_id") REFERENCES "public"."amendment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_dispute" ADD CONSTRAINT "agreement_dispute_restricted_by_user_id_user_account_id_fk" FOREIGN KEY ("restricted_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD CONSTRAINT "payment_dispute_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD CONSTRAINT "payment_dispute_claimed_by_user_id_user_account_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute" ADD CONSTRAINT "payment_dispute_resolved_by_user_id_user_account_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON "agreement_dispute" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "payment_dispute" FROM anon, authenticated;