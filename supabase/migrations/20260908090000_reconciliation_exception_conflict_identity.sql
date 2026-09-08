ALTER TYPE "public"."reconciliation_exception_type" ADD VALUE 'processor_fee_mismatch';--> statement-breakpoint
ALTER TYPE "public"."reconciliation_exception_type" ADD VALUE 'platform_fee_mismatch';--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_exception_open_identity_unique" ON "reconciliation_exception" USING btree ("payment_attempt_id","provider_event_id","exception_type") WHERE "reconciliation_exception"."status" = 'open';
