-- Reconciliation fix (2026-08-11): audit_event was created in the very first migration
-- (Phase 0/Sprint 1) before the REVOKE-lockdown convention every other table in this schema
-- follows (see 0000_nervous_speedball.sql's comment, repeated in every subsequent migration) was
-- consistently applied. No local Drizzle migration or src/db/schema/audit.ts ever revoked
-- anon/authenticated privileges on this table — this migration closes that gap on the remote
-- database only, without changing application/schema source. Row Level Security was already
-- enabled on this table via Supabase's own project-level default; this REVOKE is the same
-- defense-in-depth grant lockdown every other table already has.
REVOKE ALL ON "audit_event" FROM anon, authenticated;
