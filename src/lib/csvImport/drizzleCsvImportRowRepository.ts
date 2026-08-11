import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { csvImportRow } from "@/db/schema";
import type {
  CsvImportRowDuplicateStatus,
  CsvImportRowRecord,
  CsvImportRowRepository,
  CsvImportRowValidationStatus,
} from "./csvImportService";

type Row = typeof csvImportRow.$inferSelect;

function toRecord(row: Row): CsvImportRowRecord {
  return {
    id: row.id,
    batchId: row.batchId,
    rowNumber: row.rowNumber,
    customerEmail: row.customerEmail,
    customerName: row.customerName,
    invoiceReference: row.invoiceReference,
    balanceMinorUnits: row.balanceMinorUnits,
    proposedInstallmentAmountMinorUnits: row.proposedInstallmentAmountMinorUnits,
    proposedFrequency: row.proposedFrequency,
    proposedFirstPaymentDate: row.proposedFirstPaymentDate,
    validationStatus: row.validationStatus,
    validationErrors: (row.validationErrors as string[] | null) ?? null,
    duplicateStatus: row.duplicateStatus,
    createdDraftAgreementId: row.createdDraftAgreementId,
    createdAt: row.createdAt,
  };
}

export class DrizzleCsvImportRowRepository implements CsvImportRowRepository {
  async insertMany(
    rows: Omit<CsvImportRowRecord, "id" | "validationStatus" | "validationErrors" | "duplicateStatus" | "createdDraftAgreementId" | "createdAt">[],
  ): Promise<CsvImportRowRecord[]> {
    if (rows.length === 0) return [];
    const db = getDb();
    const inserted = await db.insert(csvImportRow).values(rows).returning();
    return inserted.map(toRecord);
  }

  async listForBatch(batchId: string): Promise<CsvImportRowRecord[]> {
    const db = getDb();
    const rows = await db.select().from(csvImportRow).where(eq(csvImportRow.batchId, batchId)).orderBy(asc(csvImportRow.rowNumber));
    return rows.map(toRecord);
  }

  async updateValidation(
    id: string,
    input: { validationStatus: CsvImportRowValidationStatus; validationErrors: string[] | null; duplicateStatus: CsvImportRowDuplicateStatus },
  ): Promise<void> {
    const db = getDb();
    await db
      .update(csvImportRow)
      .set({
        validationStatus: input.validationStatus,
        validationErrors: input.validationErrors,
        duplicateStatus: input.duplicateStatus,
      })
      .where(eq(csvImportRow.id, id));
  }

  async setCreatedDraftAgreementId(id: string, agreementId: string): Promise<void> {
    const db = getDb();
    await db.update(csvImportRow).set({ createdDraftAgreementId: agreementId }).where(eq(csvImportRow.id, id));
  }
}
