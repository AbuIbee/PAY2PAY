import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementVersion } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  AgreementTerms,
  AgreementVersionRecord,
  AgreementVersionRepository,
  FeeAllocation,
  PartyRole,
} from "./agreementService";
import type { PaymentFrequency } from "./schedule";

type Row = typeof agreementVersion.$inferSelect;

function toRecord(row: Row): AgreementVersionRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    versionNumber: row.versionNumber,
    parentVersionId: row.parentVersionId,
    isOriginal: row.isOriginal,
    producedBy: row.producedBy,
    frequency: row.frequency,
    feeAllocation: row.feeAllocation,
    terms: row.terms as AgreementTerms,
    documentHash: row.documentHash,
    creditorSignedAt: row.creditorSignedAt,
    debtorSignedAt: row.debtorSignedAt,
    signedAt: row.signedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleAgreementVersionRepository implements AgreementVersionRepository {
  async insert(input: {
    agreementId: string;
    versionNumber: number;
    parentVersionId: string | null;
    isOriginal: boolean;
    producedBy: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
  }): Promise<AgreementVersionRecord> {
    const db = getDb();
    const [row] = await db
      .insert(agreementVersion)
      .values({ ...input, terms: input.terms as object })
      .returning();
    if (!row) throw new ConfigurationError("agreement_version insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AgreementVersionRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreementVersion).where(eq(agreementVersion.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listForAgreement(agreementId: string): Promise<AgreementVersionRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agreementVersion)
      .where(eq(agreementVersion.agreementId, agreementId))
      .orderBy(asc(agreementVersion.versionNumber));
    return rows.map(toRecord);
  }

  async updateTerms(
    id: string,
    input: { frequency: PaymentFrequency; feeAllocation: FeeAllocation; terms: AgreementTerms },
  ): Promise<void> {
    const db = getDb();
    await db
      .update(agreementVersion)
      .set({ frequency: input.frequency, feeAllocation: input.feeAllocation, terms: input.terms as object })
      .where(eq(agreementVersion.id, id));
  }

  async recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<void> {
    const db = getDb();
    await db
      .update(agreementVersion)
      .set(role === "creditor" ? { creditorSignedAt: signedAt } : { debtorSignedAt: signedAt })
      .where(eq(agreementVersion.id, id));
  }

  async lock(id: string, input: { documentHash: string; signedAt: Date }): Promise<void> {
    const db = getDb();
    await db
      .update(agreementVersion)
      .set({ documentHash: input.documentHash, signedAt: input.signedAt })
      .where(eq(agreementVersion.id, id));
  }

  async clearSignatures(id: string): Promise<void> {
    const db = getDb();
    await db.update(agreementVersion).set({ creditorSignedAt: null, debtorSignedAt: null }).where(eq(agreementVersion.id, id));
  }
}
