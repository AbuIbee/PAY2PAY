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
ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_reviewed_by_user_id_user_account_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;