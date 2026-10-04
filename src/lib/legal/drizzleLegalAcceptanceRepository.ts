import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { legalAcceptance } from "@/db/schema";
import type { LegalAcceptanceRecord, LegalAcceptanceRepository } from "./legalAcceptanceRepository";

type Row = typeof legalAcceptance.$inferSelect;

function toRecord(row: Row): LegalAcceptanceRecord {
  return {
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    documentType: row.documentType,
    documentVersion: row.documentVersion,
    acceptedAt: row.acceptedAt,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

export class DrizzleLegalAcceptanceRepository implements LegalAcceptanceRepository {
  async insert(input: {
    userId: string;
    organizationId: string | null;
    documentType: string;
    documentVersion: string;
    acceptedAt: Date;
    metadata: Record<string, unknown> | null;
  }): Promise<LegalAcceptanceRecord> {
    const db = getDb();
    const [row] = await db
      .insert(legalAcceptance)
      .values({
        userId: input.userId,
        organizationId: input.organizationId,
        documentType: input.documentType,
        documentVersion: input.documentVersion,
        acceptedAt: input.acceptedAt,
        metadata: input.metadata,
      })
      .returning();
    if (!row) throw new Error("legal_acceptance insert returned no row");
    return toRecord(row);
  }

  async findCurrent(input: { userId: string; organizationId: string | null; documentType: string; documentVersion: string }): Promise<LegalAcceptanceRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(legalAcceptance)
      .where(
        and(
          eq(legalAcceptance.userId, input.userId),
          input.organizationId === null ? isNull(legalAcceptance.organizationId) : eq(legalAcceptance.organizationId, input.organizationId),
          eq(legalAcceptance.documentType, input.documentType),
          eq(legalAcceptance.documentVersion, input.documentVersion),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findCurrentForOrganization(input: { organizationId: string; documentType: string; documentVersion: string }): Promise<LegalAcceptanceRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(legalAcceptance)
      .where(and(eq(legalAcceptance.organizationId, input.organizationId), eq(legalAcceptance.documentType, input.documentType), eq(legalAcceptance.documentVersion, input.documentVersion)))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listForOrganization(organizationId: string): Promise<LegalAcceptanceRecord[]> {
    const db = getDb();
    const rows = await db.select().from(legalAcceptance).where(eq(legalAcceptance.organizationId, organizationId));
    return rows.map(toRecord);
  }
}
