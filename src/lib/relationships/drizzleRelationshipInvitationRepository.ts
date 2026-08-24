import "server-only";
import { and, eq, lte, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { relationshipInvitation } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type {
  RelationshipInvitationRecord,
  RelationshipInvitationRepository,
  RelationshipInvitationStatus,
} from "./relationshipInvitationService";

type Row = typeof relationshipInvitation.$inferSelect;

function toRecord(row: Row): RelationshipInvitationRecord {
  return {
    id: row.id,
    relationshipId: row.relationshipId,
    inviterUserId: row.inviterUserId,
    inviteeEmail: row.inviteeEmail,
    inviteeRole: row.inviteeRole as PartyRole,
    status: row.status as RelationshipInvitationStatus,
    tokenHash: row.tokenHash,
    resolvedInviteeUserId: row.resolvedInviteeUserId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    viewedAt: row.viewedAt,
    acceptedAt: row.acceptedAt,
    declinedAt: row.declinedAt,
    cancelledAt: row.cancelledAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleRelationshipInvitationRepository implements RelationshipInvitationRepository {
  async insert(input: {
    relationshipId: string;
    inviterUserId: string;
    inviteeEmail: string;
    inviteeRole: PartyRole;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RelationshipInvitationRecord> {
    const db = getDb();
    const [row] = await db.insert(relationshipInvitation).values(input).returning();
    if (!row) throw new ConfigurationError("relationship_invitation insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<RelationshipInvitationRecord | null> {
    const db = getDb();
    const rows = await db.select().from(relationshipInvitation).where(eq(relationshipInvitation.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<RelationshipInvitationRecord | null> {
    const db = getDb();
    const rows = await db.select().from(relationshipInvitation).where(eq(relationshipInvitation.tokenHash, tokenHash)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByRelationshipId(relationshipId: string): Promise<RelationshipInvitationRecord[]> {
    const db = getDb();
    const rows = await db.select().from(relationshipInvitation).where(eq(relationshipInvitation.relationshipId, relationshipId));
    return rows.map(toRecord);
  }

  async findPendingForInvitee(userId: string): Promise<RelationshipInvitationRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(relationshipInvitation)
      .where(
        and(
          eq(relationshipInvitation.resolvedInviteeUserId, userId),
          or(eq(relationshipInvitation.status, "sent"), eq(relationshipInvitation.status, "viewed")),
        ),
      );
    return rows.map(toRecord);
  }

  async setResolvedInviteeUser(id: string, userId: string): Promise<RelationshipInvitationRecord> {
    const db = getDb();
    const [row] = await db
      .update(relationshipInvitation)
      .set({ resolvedInviteeUserId: userId, updatedAt: new Date() })
      .where(eq(relationshipInvitation.id, id))
      .returning();
    if (!row) throw new ConfigurationError("relationship_invitation setResolvedInviteeUser found no row");
    return toRecord(row);
  }

  async markViewed(id: string): Promise<RelationshipInvitationRecord> {
    return this.setStatus(id, "viewed", { viewedAt: new Date() });
  }

  async markAccepted(id: string): Promise<RelationshipInvitationRecord | null> {
    return this.setStatusGuarded(id, "accepted", { acceptedAt: new Date() });
  }

  async markDeclined(id: string): Promise<RelationshipInvitationRecord | null> {
    return this.setStatusGuarded(id, "declined", { declinedAt: new Date() });
  }

  async markCancelled(id: string): Promise<RelationshipInvitationRecord | null> {
    return this.setStatusGuarded(id, "cancelled", { cancelledAt: new Date() });
  }

  async markExpired(id: string): Promise<RelationshipInvitationRecord> {
    return this.setStatus(id, "expired", {});
  }

  async findDueForExpiry(now: Date): Promise<RelationshipInvitationRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(relationshipInvitation)
      .where(
        and(
          lte(relationshipInvitation.expiresAt, now),
          or(eq(relationshipInvitation.status, "sent"), eq(relationshipInvitation.status, "viewed")),
        ),
      );
    return rows.map(toRecord);
  }

  private async setStatus(
    id: string,
    status: RelationshipInvitationStatus,
    extra: Partial<{ viewedAt: Date; acceptedAt: Date; declinedAt: Date; cancelledAt: Date }>,
  ): Promise<RelationshipInvitationRecord> {
    const db = getDb();
    const [row] = await db
      .update(relationshipInvitation)
      .set({ status, updatedAt: new Date(), ...extra })
      .where(eq(relationshipInvitation.id, id))
      .returning();
    if (!row) throw new ConfigurationError(`relationship_invitation setStatus(${status}) found no row`);
    return toRecord(row);
  }

  /**
   * PRSprint 31: accept/decline/cancel are mutually-exclusive terminal decisions on the same
   * invitation — unlike `setStatus` above (used only for `markViewed`/`markExpired`, which are not in
   * contention with each other), these must only succeed while the row is still `sent`/`viewed`,
   * atomically, in the same statement as the write (`WHERE status IN (...)` — never a separate
   * read-then-write, which is exactly the TOCTOU gap that let a concurrent accept and cancel both
   * appear to succeed). Returns `null` — never throws — when another decision already won the race;
   * the caller (relationshipInvitationService.ts) turns that into its own "no longer open" error.
   */
  private async setStatusGuarded(
    id: string,
    status: RelationshipInvitationStatus,
    extra: Partial<{ acceptedAt: Date; declinedAt: Date; cancelledAt: Date }>,
  ): Promise<RelationshipInvitationRecord | null> {
    const db = getDb();
    const [row] = await db
      .update(relationshipInvitation)
      .set({ status, updatedAt: new Date(), ...extra })
      .where(and(eq(relationshipInvitation.id, id), or(eq(relationshipInvitation.status, "sent"), eq(relationshipInvitation.status, "viewed"))))
      .returning();
    return row ? toRecord(row) : null;
  }
}
