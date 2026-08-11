CREATE TYPE "public"."ledger_account_type" AS ENUM('processor_clearing', 'creditor_proceeds_payable', 'platform_fee_revenue', 'processor_fee_expense', 'creditor_clawback_exposure', 'admin_adjustment_suspense');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('payment_cleared', 'refund', 'reversal', 'payout', 'dispute_adjustment', 'admin_adjustment');--> statement-breakpoint
CREATE TYPE "public"."ledger_posting_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_exception_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_exception_type" AS ENUM('missing_provider_transaction', 'unmatched_provider_transaction', 'amount_mismatch', 'currency_mismatch', 'duplicate_transaction', 'status_mismatch', 'reversal_refund_mismatch', 'stale_pending_settlement', 'internal_posting_failure', 'provider_event_without_internal_state');--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE 'reversed';--> statement-breakpoint
CREATE TABLE "ledger_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_type" "ledger_account_type" NOT NULL,
	"agreement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ledger_journal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"agreement_id" uuid NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_journal_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ledger_posting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_type" "ledger_account_type" NOT NULL,
	"direction" "ledger_posting_direction" NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_posting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reconciliation_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exception_type" "reconciliation_exception_type" NOT NULL,
	"payment_attempt_id" uuid,
	"provider_event_id" text,
	"details" jsonb,
	"status" "reconciliation_exception_status" DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolution_reason" text
);
--> statement-breakpoint
ALTER TABLE "reconciliation_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "payout_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journal_entry" ADD CONSTRAINT "ledger_journal_entry_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journal_entry" ADD CONSTRAINT "ledger_journal_entry_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_posting" ADD CONSTRAINT "ledger_posting_journal_entry_id_ledger_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."ledger_journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_posting" ADD CONSTRAINT "ledger_posting_account_id_ledger_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exception" ADD CONSTRAINT "reconciliation_exception_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exception" ADD CONSTRAINT "reconciliation_exception_resolved_by_user_id_user_account_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_account_type_agreement_unique" ON "ledger_account" USING btree ("account_type","agreement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journal_entry_payment_type_unique" ON "ledger_journal_entry" USING btree ("payment_attempt_id","entry_type");--> statement-breakpoint
REVOKE ALL ON "ledger_account" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "ledger_journal_entry" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "ledger_posting" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "reconciliation_exception" FROM anon, authenticated;
