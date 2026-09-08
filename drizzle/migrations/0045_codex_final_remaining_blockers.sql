ALTER TABLE "payment_attempt" ADD COLUMN "financial_repair_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_retry" ADD COLUMN "next_resolution_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_attempt_financial_repair_idx" ON "payment_attempt" USING btree ("status","financial_repair_next_attempt_at","updated_at");--> statement-breakpoint
CREATE INDEX "payment_retry_claimed_resumption_idx" ON "payment_retry" USING btree ("status","next_resolution_attempt_at","id");