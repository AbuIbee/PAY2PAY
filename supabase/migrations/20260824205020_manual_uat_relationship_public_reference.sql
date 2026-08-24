-- Manual UAT Critical Remediation (#2/#3): a short, human-readable, non-enumerable relationship
-- reference ("P2P-XXXX-XXXX") for support conversations, admin search, and both parties' own
-- reference to a relationship — never the raw internal UUID. Nullable/additive, not backfilled here
-- — every new relationship gets one immediately (DrizzleRelationshipRepository.insert), and a
-- pre-existing row without one gets it lazily on first read (RelationshipService.
-- ensurePublicReference), mirroring user_account.public_reference's identical Section K precedent
-- exactly. Deliberately not a security credential: relationship_invitation.token_hash remains the
-- sole authority over who may accept/decline an invitation. No REVOKE needed here (already applied
-- to relationship at table-creation time; this only adds a column to an existing, already-locked-
-- down table).
ALTER TABLE "relationship" ADD COLUMN "public_reference" text;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_public_reference_unique" ON "relationship" USING btree ("public_reference");
