ALTER TYPE "public"."payment_method" ADD VALUE 'manual_off_platform';--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "recorded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "recipient_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_recorded_by_user_id_user_account_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;
