CREATE TABLE "rate_limit_bucket" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_bucket_count_positive" CHECK ("rate_limit_bucket"."count" > 0)
);
--> statement-breakpoint
ALTER TABLE "rate_limit_bucket" ENABLE ROW LEVEL SECURITY;