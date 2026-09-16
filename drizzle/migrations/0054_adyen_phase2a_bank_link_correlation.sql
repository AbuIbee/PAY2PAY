ALTER TYPE "public"."bank_link_attempt_status" ADD VALUE 'authorised' BEFORE 'completed';--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ALTER COLUMN "existing_stored_payment_method_ids" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD COLUMN "merchant_reference" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD CONSTRAINT "bank_link_attempt_merchant_reference_unique" UNIQUE("merchant_reference");--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD COLUMN "institution_display_name" text;--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD COLUMN "confirmed_psp_reference" text;--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD COLUMN "confirmed_at" timestamp with time zone;
