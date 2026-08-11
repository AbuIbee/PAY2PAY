import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { evidenceDocument } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { EvidenceRecord, EvidenceRepository, EvidenceWithdrawalState } from "./evidenceService";

type Row = typeof evidenceDocument.$inferSelect;

function toRecord(row: Row): EvidenceRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    uploadedByUserId: row.uploadedByUserId,
    documentType: row.documentType,
    description: row.description,
    storagePath: row.storagePath,
    documentHash: row.documentHash,
    fileSizeBytes: row.fileSizeBytes,
    contentType: row.contentType,
    isPostSigning: row.isPostSigning,
    visibility: row.visibility,
    sharedWithWitnesses: row.sharedWithWitnesses,
    disputeFlag: row.disputeFlag,
    withdrawalState: row.withdrawalState,
    fileValidationStatus: row.fileValidationStatus,
    uploadedAt: row.uploadedAt,
  };
}

export class DrizzleEvidenceRepository implements EvidenceRepository {
  async insert(
    input: Omit<EvidenceRecord, "id" | "uploadedAt" | "disputeFlag" | "withdrawalState">,
  ): Promise<EvidenceRecord> {
    const db = getDb();
    const [row] = await db.insert(evidenceDocument).values(input).returning();
    if (!row) throw new ConfigurationError("evidence_document insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<EvidenceRecord | null> {
    const db = getDb();
    const rows = await db.select().from(evidenceDocument).where(eq(evidenceDocument.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listForAgreement(agreementId: string): Promise<EvidenceRecord[]> {
    const db = getDb();
    const rows = await db.select().from(evidenceDocument).where(eq(evidenceDocument.agreementId, agreementId));
    return rows.map(toRecord);
  }

  async updateWithdrawalState(id: string, state: EvidenceWithdrawalState): Promise<void> {
    const db = getDb();
    await db.update(evidenceDocument).set({ withdrawalState: state }).where(eq(evidenceDocument.id, id));
  }

  async updateDisputeFlag(id: string, flag: boolean): Promise<void> {
    const db = getDb();
    await db.update(evidenceDocument).set({ disputeFlag: flag }).where(eq(evidenceDocument.id, id));
  }
}
