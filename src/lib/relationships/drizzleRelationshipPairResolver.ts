import "server-only";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { relationship, relationshipParticipant } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import { generateRelationshipReferenceCode } from "@/lib/auth/token";
import type { PartyRef } from "./relationshipInvitationService";
import type { RelationshipPairResolver } from "./relationshipService";

const TERMINAL_STATUSES = ["restricted", "suspended", "closed", "cancelled"] as const;

function partyKey(party: PartyRef): string {
  return `${party.kind}:${party.id}`;
}

function partyMatch(party: PartyRef) {
  return party.kind === "personal"
    ? eq(relationshipParticipant.individualProfileId, party.id)
    : eq(relationshipParticipant.organizationId, party.id);
}

/**
 * Real implementation of `RelationshipPairResolver` (see that interface's own doc comment in
 * relationshipService.ts). Runs entirely inside one transaction, serialized by a Postgres advisory
 * lock keyed on the unordered pair of party ids — concurrent calls for the *same two parties* (e.g.
 * two agreement invitations between the same pair of people accepted within the same instant) queue
 * behind each other rather than racing, so "search for an existing relationship, else create one" can
 * never observe a half-finished concurrent insert and create a second, redundant relationship for
 * that pair. `pg_advisory_xact_lock` is transaction-scoped — released automatically on commit or
 * rollback, never leaked if this process crashes mid-transaction.
 *
 * Matching is on authoritative profile kind+id only (`individual_profile_id`/`organization_id`),
 * never on name or email — mirrors `RelationshipService.linkAgreement`'s own exact-counterparty check.
 *
 * Decision 1 (reversed-role safety): matching is by PARTY IDENTITY only, deliberately ignoring which
 * role (`creditor`/`debtor`) each party currently holds on an existing relationship's participant
 * rows — a connection is role-neutral; only the individual agreement being linked has a role. Matching
 * by identity+role together would fail to find an existing connection the moment two parties reuse it
 * for a second agreement with reversed roles, silently creating a duplicate connection instead of
 * reusing the real one. Whether it's actually SAFE to link a given agreement to the relationship this
 * resolves to (e.g. a live, non-terminal role conflict with another agreement already on it) is
 * `RelationshipService.linkAgreement`'s own job, called immediately after this — never duplicated here.
 *
 * Decision 2 (canonical connection): a candidate relationship is no longer required to have no
 * governing agreement yet — "Connection identity = the two parties," independent of how many
 * agreements they've already made together. Only a terminal relationship status (restricted/
 * suspended/closed/cancelled) excludes a candidate — never reused once genuinely dead, but otherwise
 * available regardless of `current_agreement_id`. Creating a brand-new relationship inserts both
 * participant rows directly, already `active` — no invitation/token is generated, since both parties'
 * identities are already established by the caller (see
 * `RelationshipService.establishAgreementRelationship`'s doc comment).
 */
export class DrizzleRelationshipPairResolver implements RelationshipPairResolver {
  async resolveForExactParties(input: {
    creditor: PartyRef;
    creditorUserId: string;
    debtor: PartyRef;
    debtorUserId: string;
    initiatorUserId: string;
  }): Promise<{ relationshipId: string }> {
    const db = getDb();
    const [lockKeyA, lockKeyB] = [partyKey(input.creditor), partyKey(input.debtor)].sort();

    return db.transaction(async (tx) => {
      // Serialization point: any other call resolving this same unordered pair blocks here until this
      // transaction commits or rolls back — see this class's own doc comment.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKeyA}), hashtext(${lockKeyB}))`);

      const partyARows = await tx
        .select({ relationshipId: relationshipParticipant.relationshipId })
        .from(relationshipParticipant)
        .where(and(eq(relationshipParticipant.status, "active"), partyMatch(input.creditor)));
      const partyBRows = await tx
        .select({ relationshipId: relationshipParticipant.relationshipId })
        .from(relationshipParticipant)
        .where(and(eq(relationshipParticipant.status, "active"), partyMatch(input.debtor)));

      const partyBRelationshipIds = new Set(partyBRows.map((r) => r.relationshipId));
      const candidateIds = [...new Set(partyARows.map((r) => r.relationshipId))].filter((id) => partyBRelationshipIds.has(id));

      if (candidateIds.length > 0) {
        const candidates = await tx
          .select()
          .from(relationship)
          .where(and(inArray(relationship.id, candidateIds), notInArray(relationship.status, [...TERMINAL_STATUSES])))
          .orderBy(asc(relationship.createdAt))
          .limit(1);
        if (candidates[0]) {
          return { relationshipId: candidates[0].id };
        }
      }

      const [newRelationship] = await tx
        .insert(relationship)
        .values({ initiatorUserId: input.initiatorUserId, publicReference: generateRelationshipReferenceCode() })
        .returning();
      if (!newRelationship) throw new ConfigurationError("relationship insert returned no row during pair resolution");

      await tx.insert(relationshipParticipant).values([
        {
          relationshipId: newRelationship.id,
          individualProfileId: input.creditor.kind === "personal" ? input.creditor.id : null,
          organizationId: input.creditor.kind === "business" ? input.creditor.id : null,
          role: "creditor",
          status: "active",
          representedByUserId: input.creditorUserId,
          joinedAt: new Date(),
        },
        {
          relationshipId: newRelationship.id,
          individualProfileId: input.debtor.kind === "personal" ? input.debtor.id : null,
          organizationId: input.debtor.kind === "business" ? input.debtor.id : null,
          role: "debtor",
          status: "active",
          representedByUserId: input.debtorUserId,
          joinedAt: new Date(),
        },
      ]);

      return { relationshipId: newRelationship.id };
    });
  }
}
