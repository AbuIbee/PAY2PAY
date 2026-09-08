CREATE TYPE "public"."payment_webhook_processing_status" AS ENUM('received', 'processing', 'processed', 'failed');--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "processing_status" "payment_webhook_processing_status" DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "last_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_webhook_event_recovery_scan_idx" ON "payment_webhook_event" USING btree ("processing_status","next_retry_at","lease_expires_at");--> statement-breakpoint
-- R06 backfill: every existing row defaulted to processing_status='received' above (the column's own
-- DEFAULT), which is only correct for a row that was never actually processed. A pre-existing row
-- that already has processed_at set genuinely WAS fully processed under the old code — map it
-- forward to 'processed' so the recovery scheduler never re-claims and re-applies already-completed
-- work. Every other pre-existing row (processed_at IS NULL) correctly stays 'received' — its own
-- column default — making it immediately, safely eligible for the recovery scheduler to complete,
-- exactly the "existing unprocessed rows must become safely recoverable" requirement.
UPDATE "payment_webhook_event" SET "processing_status" = 'processed' WHERE "processed_at" IS NOT NULL;