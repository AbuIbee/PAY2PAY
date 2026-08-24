-- Closed-Beta Critical Remediation, Section K: a short, user-facing account identifier
-- ("P2P-XXXXXXXX") for support conversations and admin search, so a user is never asked to read out
-- their raw internal UUID. Nullable/additive, not backfilled here — every new signup gets one
-- immediately (DrizzleUserAccountRepository.insert), and a pre-existing row without one gets it
-- lazily, generated and persisted the first time it's actually read (AuthService.ensurePublicReference)
-- rather than via a blocking data migration against every existing row up front. Non-sequential and
-- non-enumerable by construction (random from a 32-symbol alphabet, not a counter). No REVOKE needed
-- here (already applied to user_account at table-creation time; this only adds a column to an
-- existing, already-locked-down table).
ALTER TABLE "user_account" ADD COLUMN "public_reference" text;--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_public_reference_unique" UNIQUE("public_reference");
