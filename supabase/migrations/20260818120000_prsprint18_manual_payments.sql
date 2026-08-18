-- PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md):
-- "manual_off_platform" as a distinct payment_method — a payment collected outside this platform's
-- payment rails (cash, check, an external transfer) that a party records for evidentiary/bookkeeping
-- purposes, distinct from a provider-verified (ach/debit_card) attempt this platform itself
-- processed. recorded_by_user_id attributes who logged it; recipient_confirmed_at is the optional,
-- purely evidentiary counterparty confirmation (never a gate on the payment already counting toward
-- the agreement's balance — see paymentService.ts's recordManualOffPlatformPayment doc comment).
-- payment_attempt already has RLS enabled with zero CREATE POLICY statements (PRSprint 02's
-- established deny-all-for-anon/authenticated precedent) — these are additive nullable columns, no
-- RLS/REVOKE change needed.
ALTER TYPE "public"."payment_method" ADD VALUE 'manual_off_platform';
ALTER TABLE "payment_attempt" ADD COLUMN "recorded_by_user_id" uuid;
ALTER TABLE "payment_attempt" ADD COLUMN "recipient_confirmed_at" timestamp with time zone;
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_recorded_by_user_id_user_account_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;
