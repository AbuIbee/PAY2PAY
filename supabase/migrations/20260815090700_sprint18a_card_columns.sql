ALTER TABLE "financial_account" ADD COLUMN "card_expiry_month" integer;--> statement-breakpoint
ALTER TABLE "financial_account" ADD COLUMN "card_expiry_year" integer;--> statement-breakpoint
ALTER TABLE "financial_account" ADD COLUMN "card_brand" text;