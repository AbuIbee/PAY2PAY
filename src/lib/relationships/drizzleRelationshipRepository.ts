import "server-only";
import { eq, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { relationship, relationshipParticipant } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { RelationshipRecord, RelationshipRepository, RelationshipStatus } from "./relationshipService";

type Row = typeof relationship.$inferSelect;

function toRecord(row: Row): RelationshipRecord {
  return {
    id: row.id,
    status: row.status as RelationshipStatus,
    context: row.context,
    initiatorUserId: row.initiatorUserId,
    currentAgreementId: row.currentAgreementId,
    activatedAt: row.activatedAt,
    restrictedAt: row.restrictedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleRelationshipRepository implements RelationshipRepository {
  async insert(input: { initiatorUserId: string }): Promise<RelationshipRecord> {
    const db = getDb();
    const [row] = await db.insert(relationship).values({ initiatorUserId: input.initiatorUserId }).returning();
    if (!row) throw new ConfigurationError("relationship insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<RelationshipRecord | null> {
    const db = getDb();
    const rows = await db.select().from(relationship).where(eq(relationship.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForParticipant(individualProfileId: string | null, organizationId: string | null): Promise<RelationshipRecord[]> {
    const db = getDb();
    const conditions = [];
    if (individualProfileId) conditions.push(eq(relationshipParticipant.individualProfileId, individualProfileId));
    if (organizationId) conditions.push(eq(relationshipParticipant.organizationId, organizationId));
    if (conditions.length === 0) return [];
    const rows = await db
      .selectDistinct({ relationship })
      .from(relationship)
      .innerJoin(relationshipParticipant, eq(relationshipParticipant.relationshipId, relationship.id))
      .where(or(...conditions));
    return rows.map((r) => toRecord(r.relationship));
  }

  async setCurrentAgreementId(id: string, agreementId: string): Promise<RelationshipRecord> {
    const db = getDb();
    const [row] = await db.update(relationship).set({ currentAgreementId: agreementId, updatedAt: new Date() }).where(eq(relationship.id, id)).returning();
    if (!row) throw new ConfigurationError("relationship setCurrentAgreementId found no row");
    return toRecord(row);
  }

  async updateStatus(id: string, status: RelationshipStatus): Promise<RelationshipRecord> {
    const db = getDb();
    const [row] = await db.update(relationship).set({ status, updatedAt: new Date() }).where(eq(relationship.id, id)).returning();
    if (!row) throw new ConfigurationError("relationship updateStatus found no row");
    return toRecord(row);
  }

  async markCounterpartyLinked(id: string): Promise<RelationshipRecord> {
    return this.updateStatus(id, "counterparty_linked");
  }

  async markActivated(id: string): Promise<RelationshipRecord> {
    const db = getDb();
    const [row] = await db
      .update(relationship)
      .set({ status: "active", activatedAt: new Date(), updatedAt: new Date() })
      .where(eq(relationship.id, id))
      .returning();
    if (!row) throw new ConfigurationError("relationship markActivated found no row");
    return toRecord(row);
  }

  async markRestricted(id: string): Promise<RelationshipRecord> {
    const db = getDb();
    const [row] = await db
      .update(relationship)
      .set({ status: "restricted", restrictedAt: new Date(), updatedAt: new Date() })
      .where(eq(relationship.id, id))
      .returning();
    if (!row) throw new ConfigurationError("relationship markRestricted found no row");
    return toRecord(row);
  }

  async markClosed(id: string): Promise<RelationshipRecord> {
    const db = getDb();
    const [row] = await db
      .update(relationship)
      .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
      .where(eq(relationship.id, id))
      .returning();
    if (!row) throw new ConfigurationError("relationship markClosed found no row");
    return toRecord(row);
  }
}
