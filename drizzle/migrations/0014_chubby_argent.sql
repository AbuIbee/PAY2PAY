CREATE TYPE "public"."payment_retry_status" AS ENUM('scheduled', 'fired', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."reschedule_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "notification_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"notification_type" text NOT NULL,
	"related_payment_attempt_id" uuid,
	"related_agreement_id" uuid,
	"payload" jsonb NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_retry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_payment_attempt_id" uuid NOT NULL,
	"installment_schedule_item_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "payment_retry_status" DEFAULT 'scheduled' NOT NULL,
	"resulting_payment_attempt_id" uuid,
	"fired_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"canceled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_retry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reschedule_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installment_schedule_item_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"requested_by_profile_kind" "profile_kind" NOT NULL,
	"requested_by_profile_id" uuid NOT NULL,
	"current_due_date" date NOT NULL,
	"requested_due_date" date NOT NULL,
	"reason" text,
	"status" "reschedule_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reschedule_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_recipient_user_id_user_account_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_related_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("related_payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_related_agreement_id_agreement_id_fk" FOREIGN KEY ("related_agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_retry" ADD CONSTRAINT "payment_retry_original_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("original_payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_retry" ADD CONSTRAINT "payment_retry_installment_schedule_item_id_installment_schedule_item_id_fk" FOREIGN KEY ("installment_schedule_item_id") REFERENCES "public"."installment_schedule_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_retry" ADD CONSTRAINT "payment_retry_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_retry" ADD CONSTRAINT "payment_retry_resulting_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("resulting_payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_request" ADD CONSTRAINT "reschedule_request_installment_schedule_item_id_installment_schedule_item_id_fk" FOREIGN KEY ("installment_schedule_item_id") REFERENCES "public"."installment_schedule_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_request" ADD CONSTRAINT "reschedule_request_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_request" ADD CONSTRAINT "reschedule_request_decided_by_user_id_user_account_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_retry_original_payment_attempt_unique" ON "payment_retry" USING btree ("original_payment_attempt_id");--> statement-breakpoint
-- Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): same RLS lockdown rationale as
-- every prior migration in this project (see 0000_nervous_speedball.sql's comment) — RLS is enabled
-- above with zero permissive policies for anon/authenticated, and these REVOKEs are defense in depth
-- against Supabase's default-privilege auto-grants on new public-schema tables.
REVOKE ALL ON "notification_event" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "payment_retry" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "reschedule_request" FROM anon, authenticated;