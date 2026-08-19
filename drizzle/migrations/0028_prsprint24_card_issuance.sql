CREATE TYPE "public"."card_transaction_event_type" AS ENUM('authorization', 'clearing', 'settlement', 'decline', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."issued_card_status" AS ENUM('requested', 'pending_issuance', 'issued', 'active', 'frozen', 'lost', 'stolen', 'replaced', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."issued_card_type" AS ENUM('virtual', 'physical');--> statement-breakpoint
CREATE TABLE "card_transaction_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issued_card_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" "card_transaction_event_type" NOT NULL,
	"provider_transaction_ref" text NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"merchant_display_name" text,
	"signature_verified" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "card_transaction_event_amount_positive" CHECK ("card_transaction_event"."amount_minor_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "card_transaction_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "issued_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"individual_profile_id" uuid,
	"organization_id" uuid,
	"card_type" "issued_card_type" NOT NULL,
	"provider_name" text NOT NULL,
	"provider_card_ref" text,
	"card_last4" text,
	"card_brand" text,
	"expires_at_month" integer,
	"expires_at_year" integer,
	"status" "issued_card_status" DEFAULT 'requested' NOT NULL,
	"shipping_address" jsonb,
	"activated_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"frozen_reason" text,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"supersedes_card_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issued_card_exactly_one_party" CHECK (("issued_card"."individual_profile_id" IS NOT NULL AND "issued_card"."organization_id" IS NULL) OR ("issued_card"."individual_profile_id" IS NULL AND "issued_card"."organization_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "issued_card" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "card_transaction_event" ADD CONSTRAINT "card_transaction_event_issued_card_id_issued_card_id_fk" FOREIGN KEY ("issued_card_id") REFERENCES "public"."issued_card"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_card" ADD CONSTRAINT "issued_card_individual_profile_id_personal_profile_id_fk" FOREIGN KEY ("individual_profile_id") REFERENCES "public"."personal_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_card" ADD CONSTRAINT "issued_card_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_card" ADD CONSTRAINT "issued_card_requested_by_user_id_user_account_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_transaction_event_provider_event_unique" ON "card_transaction_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issued_card_idempotency_key_unique" ON "issued_card" USING btree ("idempotency_key");