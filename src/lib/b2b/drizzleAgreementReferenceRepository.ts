import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementReference } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AgreementReferenceRecord, AgreementReferenceRepository } from "./b2bWorkflowService";

type Row = typeof agreementReference.$inferSelect;

function toRecord(row: Row): AgreementReferenceRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    referenceType: row.referenceType,
    referenceNumber: row.referenceNumber,
    addedByUserId: row.addedByUserId,
    addedAt: row.addedAt,
  };
}

export class DrizzleAgreementReferenceRepository implements AgreementReferenceRepository {
  async insert(input: {
    agreementId: string;
    referenceType: AgreementReferenceRecord["referenceType"];
    referenceNumber: string;
    addedByUserId: string;
  }): Promise<AgreementReferenceRecord> {
    const db = getDb();
    const [row] = await db.insert(agreementReference).values(input).returning();
    if (!row) throw new ConfigurationError("agreement_reference insert returned no row");
    return toRecord(row);
  }

  async listForAgreement(agreementId: string): Promise<AgreementReferenceRecord[]> {
    const db = getDb();
    const rows = await db.select().from(agreementReference).where(eq(agreementReference.agreementId, agreementId));
    return rows.map(toRecord);
  }
}
