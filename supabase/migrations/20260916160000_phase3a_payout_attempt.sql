CREATE TYPE "public"."payout_attempt_status" AS ENUM('pending', 'confirmed', 'failed', 'returned');--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'payout_returned';--> statement-breakpoint
CREATE TABLE "payout_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"status" "payout_attempt_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"provider_name" text,
	"provider_payout_reference" text,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"returned_at" timestamp with time zone,
	"return_reason" text
);
--> statement-breakpoint
ALTER TABLE "payout_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payout_attempt" ADD CONSTRAINT "payout_attempt_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_attempt" ADD CONSTRAINT "payout_attempt_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_attempt_payment_attempt_id_unique" ON "payout_attempt" USING btree ("payment_attempt_id");
