import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { csvImportBatch } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { CsvImportBatchRecord, CsvImportBatchRepository, CsvImportBatchStatus } from "./csvImportService";

type Row = typeof csvImportBatch.$inferSelect;

function toRecord(row: Row): CsvImportBatchRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    uploadedByUserId: row.uploadedByUserId,
    fileName: row.fileName,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export class DrizzleCsvImportBatchRepository implements CsvImportBatchRepository {
  async insert(input: { businessProfileId: string; uploadedByUserId: string; fileName: string }): Promise<CsvImportBatchRecord> {
    const db = getDb();
    const [row] = await db.insert(csvImportBatch).values(input).returning();
    if (!row) throw new ConfigurationError("csv_import_batch insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<CsvImportBatchRecord | null> {
    const db = getDb();
    const rows = await db.select().from(csvImportBatch).where(eq(csvImportBatch.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async updateStatus(id: string, status: CsvImportBatchStatus): Promise<void> {
    const db = getDb();
    await db.update(csvImportBatch).set({ status }).where(eq(csvImportBatch.id, id));
  }
}
