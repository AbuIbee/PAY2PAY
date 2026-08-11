CREATE TYPE "public"."payment_attempt_status" AS ENUM('pending', 'succeeded', 'failed', 'canceled', 'refunded', 'disputed');--> statement-breakpoint
CREATE TABLE "payment_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"payer_profile_kind" "profile_kind" NOT NULL,
	"payer_profile_id" uuid NOT NULL,
	"recipient_profile_kind" "profile_kind" NOT NULL,
	"recipient_profile_id" uuid NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"agreement_id" uuid,
	"status" "payment_attempt_status" DEFAULT 'pending' NOT NULL,
	"provider_name" text NOT NULL,
	"provider_payment_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_webhook_event" (
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
ALTER TABLE "payment_webhook_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kyc_webhook_event" (
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
ALTER TABLE "kyc_webhook_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_idempotency_key_unique" ON "payment_attempt" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_provider_payment_id_unique" ON "payment_attempt" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_event_provider_event_unique" ON "payment_webhook_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_webhook_event_provider_event_unique" ON "kyc_webhook_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
REVOKE ALL ON "payment_attempt" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "payment_webhook_event" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "kyc_webhook_event" FROM anon, authenticated;
