-- PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): the shared
-- counter store behind the distributed rate limiter (src/lib/rate-limit.ts). Replaces the prior
-- in-memory Map, which only bounded abuse within a single process and does nothing on Vercel's
-- multi-instance serverless deployment. See src/db/schema/rateLimit.ts for the full design rationale
-- (atomic INSERT ... ON CONFLICT upsert, Postgres row-level locking makes this safe under
-- concurrent requests from different instances).
--
-- RLS enabled with zero CREATE POLICY statements (deny-all for anon/authenticated), matching every
-- other table in this schema (PRSprint 02's finding: this app's own DB connection queries as table
-- owner and bypasses RLS regardless — RLS here only blocks direct anon/authenticated PostgREST
-- access, which this table never receives). REVOKE added by hand, matching every prior migration.
CREATE TABLE "rate_limit_bucket" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_bucket_count_positive" CHECK ("rate_limit_bucket"."count" > 0)
);
ALTER TABLE "rate_limit_bucket" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "rate_limit_bucket" FROM anon, authenticated;
