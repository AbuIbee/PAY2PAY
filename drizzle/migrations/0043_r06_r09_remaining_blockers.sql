ALTER TYPE "public"."payment_retry_status" ADD VALUE 'claimed' BEFORE 'fired';--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "transition_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "transition_from_status" "payment_attempt_status";--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "transition_to_status" "payment_attempt_status";--> statement-breakpoint
ALTER TABLE "payment_retry" ADD COLUMN "execution_token" uuid;