CREATE TYPE "public"."payment_webhook_event_source" AS ENUM('webhook', 'provider_lookup');--> statement-breakpoint
ALTER TABLE "payment_webhook_event" ADD COLUMN "source" "payment_webhook_event_source" DEFAULT 'webhook' NOT NULL;
