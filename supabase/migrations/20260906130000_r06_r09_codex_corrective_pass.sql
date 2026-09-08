ALTER TABLE "audit_event" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "provider_payment_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_event_provider_event_action_unique" ON "audit_event" USING btree ("provider_event_id","action") WHERE "audit_event"."provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_attempt_status_updated_at_idx" ON "payment_attempt" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "payment_webhook_event_trusted_lookup_idx" ON "payment_webhook_event" USING btree ("provider","provider_payment_id","event_type","processing_status");--> statement-breakpoint
-- Backfill: populate the new provider_payment_id column for every existing row from its already-
-- stored payload, so pre-existing events remain findable via the new indexed evidence lookup
-- immediately — never left silently unindexed just because they predate this column.
UPDATE "payment_webhook_event" SET "provider_payment_id" = "payload" ->> 'providerPaymentId' WHERE "payload" ->> 'providerPaymentId' IS NOT NULL;