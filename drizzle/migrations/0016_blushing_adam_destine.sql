CREATE TYPE "public"."partial_payment_request_status" AS ENUM('proposed', 'awaiting_payment', 'applied', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."settlement_failure_consequence" AS ENUM('restore_original', 'restore_stated', 'forgive_permanently', 'prior_agreement_controls');--> statement-breakpoint
CREATE TYPE "public"."settlement_payment_mode" AS ENUM('one_time', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."settlement_proposal_status" AS ENUM('proposed', 'awaiting_payment', 'rejected', 'completed', 'failure_consequence_applied');--> statement-breakpoint
CREATE TABLE "partial_payment_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"installment_schedule_item_id" uuid,
	"status" "partial_payment_request_status" DEFAULT 'proposed' NOT NULL,
	"proposing_party_role" "agreement_party_role" NOT NULL,
	"proposed_by_profile_kind" "profile_kind" NOT NULL,
	"proposed_by_profile_id" uuid NOT NULL,
	"proposed_amount_minor_units" integer NOT NULL,
	"proposed_date" date NOT NULL,
	"explanation" text,
	"remainder_treatment" text,
	"rejected_reason" text,
	"rejected_at" timestamp with time zone,
	"payment_attempt_id" uuid,
	"applied_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partial_payment_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "settlement_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_proposal_id" uuid NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settlement_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "settlement_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"status" "settlement_proposal_status" DEFAULT 'proposed' NOT NULL,
	"proposing_party_role" "agreement_party_role" NOT NULL,
	"proposed_by_profile_kind" "profile_kind" NOT NULL,
	"proposed_by_profile_id" uuid NOT NULL,
	"pre_settlement_balance_minor_units" integer NOT NULL,
	"settlement_amount_minor_units" integer NOT NULL,
	"forgiven_amount_minor_units" integer NOT NULL,
	"deadline" date NOT NULL,
	"payment_mode" "settlement_payment_mode" NOT NULL,
	"failure_consequence" "settlement_failure_consequence" NOT NULL,
	"failure_consequence_stated_amount_minor_units" integer,
	"rejected_reason" text,
	"rejected_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"resolved_consequence" "settlement_failure_consequence",
	"resolved_restored_balance_minor_units" integer,
	"resolved_forgiven_amount_minor_units" integer,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settlement_proposal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "partial_payment_request" ADD CONSTRAINT "partial_payment_request_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partial_payment_request" ADD CONSTRAINT "partial_payment_request_installment_schedule_item_id_installment_schedule_item_id_fk" FOREIGN KEY ("installment_schedule_item_id") REFERENCES "public"."installment_schedule_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partial_payment_request" ADD CONSTRAINT "partial_payment_request_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_payment" ADD CONSTRAINT "settlement_payment_settlement_proposal_id_settlement_proposal_id_fk" FOREIGN KEY ("settlement_proposal_id") REFERENCES "public"."settlement_proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_payment" ADD CONSTRAINT "settlement_payment_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_proposal" ADD CONSTRAINT "settlement_proposal_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_payment_payment_attempt_id_unique" ON "settlement_payment" USING btree ("payment_attempt_id");--> statement-breakpoint
REVOKE ALL ON "partial_payment_request" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "settlement_payment" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "settlement_proposal" FROM anon, authenticated;