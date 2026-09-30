ALTER TYPE "public"."ledger_entry_type" ADD VALUE IF NOT EXISTS 'refund_correction';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE IF NOT EXISTS 'payout_returned';
