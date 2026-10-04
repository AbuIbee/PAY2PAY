-- "PAID2YOU — MASTER P0" (2026-10-03), Section 14/25: webhook idempotency/replay-protection tables
-- for the two new production provider integrations (Middesk business verification, Stripe platform
-- billing) — see src/db/schema/platformExpansion.ts's own doc comment. Mirrors kyc_webhook_event's
-- (20260811_sprint9... — already applied) exact shape: provider + provider_event_id unique index,
-- payload as jsonb, signature_verified recorded, processed_at nullable until applied. Both tables are
-- brand new (CREATE TABLE only) — nothing existing is altered, nothing to lose.
--
-- Generated via `npx drizzle-kit generate` against the current schema and hand-trimmed to only the
-- genuinely new statements (drizzle/migrations' own bookkeeping has drifted out of sync with this
-- project's actual canonical migration history in this directory — same situation this directory's
-- own 20261002010000 migration's header already documents and resolves the same way: take only the
-- real delta, not drizzle-kit's full re-proposed snapshot).
CREATE TABLE "business_verification_webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "business_verification_webhook_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_billing_webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "platform_billing_webhook_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "business_verification_webhook_event_provider_event_unique" ON "business_verification_webhook_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_billing_webhook_event_provider_event_unique" ON "platform_billing_webhook_event" USING btree ("provider","provider_event_id");
