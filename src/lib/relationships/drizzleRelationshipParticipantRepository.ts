import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { relationshipParticipant } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type {
  RelationshipParticipantRecord,
  RelationshipParticipantRepository,
  RelationshipParticipantStatus,
} from "./relationshipService";

type Row = typeof relationshipParticipant.$inferSelect;

function toRecord(row: Row): RelationshipParticipantRecord {
  return {
    id: row.id,
    relationshipId: row.relationshipId,
    individualProfileId: row.individualProfileId,
    organizationId: row.organizationId,
    role: row.role as PartyRole,
    status: row.status as RelationshipParticipantStatus,
    representedByUserId: row.representedByUserId,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleRelationshipParticipantRepository implements RelationshipParticipantRepository {
  async insert(input: {
    relationshipId: string;
    individualProfileId: string | null;
    organizationId: string | null;
    role: PartyRole;
    status: RelationshipParticipantStatus;
    representedByUserId: string | null;
    joinedAt: Date | null;
  }): Promise<RelationshipParticipantRecord> {
    const db = getDb();
    const [row] = await db.insert(relationshipParticipant).values(input).returning();
    if (!row) throw new ConfigurationError("relationship_participant insert returned no row");
    return toRecord(row);
  }

  async listForRelationship(relationshipId: string): Promise<RelationshipParticipantRecord[]> {
    const db = getDb();
    const rows = await db.select().from(relationshipParticipant).where(eq(relationshipParticipant.relationshipId, relationshipId));
    return rows.map(toRecord);
  }
}
