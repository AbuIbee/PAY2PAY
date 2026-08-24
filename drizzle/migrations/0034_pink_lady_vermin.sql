ALTER TABLE "user_account" ADD COLUMN "public_reference" text;--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_public_reference_unique" UNIQUE("public_reference");