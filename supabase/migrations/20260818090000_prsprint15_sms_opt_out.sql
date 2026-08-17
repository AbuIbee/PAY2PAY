-- PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md): STOP-driven SMS suppression, keyed by
-- the E.164 phone number itself (not a user id) so a number that opts out is honored regardless of
-- whether/how it's later associated with an account. RLS enabled with zero CREATE POLICY statements
-- (deny-all for anon/authenticated), matching every other table in this schema (PRSprint 02's
-- established precedent — the app's own DB connection queries as table owner and bypasses RLS
-- regardless). REVOKE added by hand, matching every prior migration.
CREATE TABLE "sms_opt_out" (
	"phone" text PRIMARY KEY NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "sms_opt_out" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "sms_opt_out" FROM anon, authenticated;
