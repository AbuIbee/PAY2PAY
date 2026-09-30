ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'refund_reversed';--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'refund_failed';
