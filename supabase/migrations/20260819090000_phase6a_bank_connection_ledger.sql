-- Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md) Ledger Payment-Source
-- Rule: "the ledger must identify a payment source using an internal bank_connection_id, never a
-- routing or account number." Adds a nullable payment_attempt.bank_connection_id referencing the
-- Sprint 18A financial_account table (never a new/duplicate account table — financial_account already
-- models "a party-owned bank connection or card"; see that table's own doc comment). Set only for an
-- ACH attempt whose active mandate carries a known financial_account_id (see
-- achMandateFinancialAccountAdapter.ts) — null for debit_card/manual_off_platform attempts and for any
-- pre-Phase-6A ACH mandate. Also adds financial_account.bank_account_subtype (checking/savings),
-- non-sensitive display metadata mirroring the existing card_expiry_month/card_brand columns'
-- identical nullable-and-type-specific pattern. Both payment_attempt and financial_account already
-- have RLS enabled with zero CREATE POLICY statements (PRSprint 02's established
-- deny-all-for-anon/authenticated precedent) — these are additive nullable columns, no RLS/REVOKE
-- change needed.
CREATE TYPE "public"."bank_account_subtype" AS ENUM('checking', 'savings');

ALTER TABLE "payment_attempt" ADD COLUMN "bank_connection_id" uuid;
ALTER TABLE "financial_account" ADD COLUMN "bank_account_subtype" "public"."bank_account_subtype";
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_bank_connection_id_financial_account_id_fk" FOREIGN KEY ("bank_connection_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;
