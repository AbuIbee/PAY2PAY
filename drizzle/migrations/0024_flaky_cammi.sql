-- PRSprint 03 (docs/prsprints/PRSPRINT_03_DATABASE_INTEGRITY_STATE_MACHINES.md): replace the full
-- (business_profile_id, user_id) unique index with a partial one scoped to active (non-removed)
-- rows only, so a business can re-hire a former staff member without a live unique-constraint
-- violation. See src/db/schema/identity.ts's businessStaffMember doc comment for the full gap
-- description. Safe against existing data: this only loosens a constraint, never tightens one.
DROP INDEX "business_staff_member_business_user_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "business_staff_member_active_business_user_unique" ON "business_staff_member" USING btree ("business_profile_id","user_id") WHERE "business_staff_member"."removed_at" IS NULL;--> statement-breakpoint
-- PRSprint 03: positive-amount backstops for the two tables that record actual money movement
-- (see src/db/schema/payment.ts and src/db/schema/ledger.ts doc comments). Added NOT VALID: this
-- migration targets a live, already-populated, production-linked database (reconciled in PRSprint
-- 01) and every existing write path already enforces positivity at the zod validation boundary, but
-- this repo has no way to safely confirm zero pre-existing violating rows from this sandbox. NOT
-- VALID applies the check to every new/updated row immediately without scanning history, so it
-- cannot fail this migration or block any legitimate future write; a follow-up
-- `VALIDATE CONSTRAINT` pass against the live database (outside this sandbox) is a known,
-- documented follow-up, not silently assumed done.
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_amount_positive" CHECK ("payment_attempt"."amount_minor_units" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_posting" ADD CONSTRAINT "ledger_posting_amount_positive" CHECK ("ledger_posting"."amount_minor_units" > 0) NOT VALID;