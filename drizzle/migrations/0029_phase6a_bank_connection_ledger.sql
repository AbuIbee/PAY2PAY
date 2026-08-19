CREATE TYPE "public"."bank_account_subtype" AS ENUM('checking', 'savings');--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "bank_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "financial_account" ADD COLUMN "bank_account_subtype" "bank_account_subtype";--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_bank_connection_id_financial_account_id_fk" FOREIGN KEY ("bank_connection_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;