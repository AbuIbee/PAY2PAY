import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementPdf } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AgreementPdfRecord, AgreementPdfRepository } from "./signatureService";

type Row = typeof agreementPdf.$inferSelect;

function toRecord(row: Row): AgreementPdfRecord {
  return {
    id: row.id,
    agreementVersionId: row.agreementVersionId,
    storagePath: row.storagePath,
    documentHash: row.documentHash,
    generatedAt: row.generatedAt,
  };
}

export class DrizzleAgreementPdfRepository implements AgreementPdfRepository {
  async insert(input: { id?: string; agreementVersionId: string; storagePath: string; documentHash: string }): Promise<AgreementPdfRecord> {
    const db = getDb();
    const [row] = await db.insert(agreementPdf).values(input).returning();
    if (!row) throw new ConfigurationError("agreement_pdf insert returned no row");
    return toRecord(row);
  }

  async findByVersion(agreementVersionId: string): Promise<AgreementPdfRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreementPdf).where(eq(agreementPdf.agreementVersionId, agreementVersionId)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }
}
