import "server-only";
import { eq, or, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { AgreementRecord, AgreementRepository, AgreementStatus } from "./agreementService";

type Row = typeof agreement.$inferSelect;

function toRecord(row: Row): AgreementRecord {
  return {
    id: row.id,
    creditorProfileKind: row.creditorProfileKind,
    creditorProfileId: row.creditorProfileId,
    debtorProfileKind: row.debtorProfileKind,
    debtorProfileId: row.debtorProfileId,
    status: row.status,
    currency: row.currency,
    country: row.country,
    currentVersionId: row.currentVersionId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}

export class DrizzleAgreementRepository implements AgreementRepository {
  async insert(input: {
    creditorProfileKind: ProfileKind;
    creditorProfileId: string;
    debtorProfileKind: ProfileKind;
    debtorProfileId: string;
    currency: string;
    createdByUserId: string;
  }): Promise<AgreementRecord> {
    const db = getDb();
    const [row] = await db.insert(agreement).values(input).returning();
    if (!row) throw new ConfigurationError("agreement insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AgreementRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreement).where(eq(agreement.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async updateStatus(id: string, status: AgreementStatus): Promise<void> {
    const db = getDb();
    await db.update(agreement).set({ status }).where(eq(agreement.id, id));
  }

  async setCurrentVersionId(id: string, versionId: string): Promise<void> {
    const db = getDb();
    await db.update(agreement).set({ currentVersionId: versionId }).where(eq(agreement.id, id));
  }

  async listForProfile(profileKind: ProfileKind, profileId: string): Promise<AgreementRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agreement)
      .where(
        or(
          and(eq(agreement.creditorProfileKind, profileKind), eq(agreement.creditorProfileId, profileId)),
          and(eq(agreement.debtorProfileKind, profileKind), eq(agreement.debtorProfileId, profileId)),
        ),
      );
    return rows.map(toRecord);
  }
}
