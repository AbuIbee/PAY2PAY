import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementWitness } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AgreementWitnessRecord, AgreementWitnessRepository } from "./witnessService";

type Row = typeof agreementWitness.$inferSelect;

function toRecord(row: Row): AgreementWitnessRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    witnessUserId: row.witnessUserId,
    addedByUserId: row.addedByUserId,
    addedAt: row.addedAt,
    attestedVersionId: row.attestedVersionId,
    attestedAt: row.attestedAt,
    ipAddress: row.ipAddress,
    deviceInfo: row.deviceInfo,
  };
}

export class DrizzleAgreementWitnessRepository implements AgreementWitnessRepository {
  async insert(input: { agreementId: string; witnessUserId: string; addedByUserId: string }): Promise<AgreementWitnessRecord> {
    const db = getDb();
    const [row] = await db.insert(agreementWitness).values(input).returning();
    if (!row) throw new ConfigurationError("agreement_witness insert returned no row");
    return toRecord(row);
  }

  async listForAgreement(agreementId: string): Promise<AgreementWitnessRecord[]> {
    const db = getDb();
    const rows = await db.select().from(agreementWitness).where(eq(agreementWitness.agreementId, agreementId));
    return rows.map(toRecord);
  }

  async findByAgreementAndUser(agreementId: string, userId: string): Promise<AgreementWitnessRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agreementWitness)
      .where(and(eq(agreementWitness.agreementId, agreementId), eq(agreementWitness.witnessUserId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async recordAttestation(
    id: string,
    input: { attestedVersionId: string; attestedAt: Date; ipAddress: string | null; deviceInfo: unknown },
  ): Promise<void> {
    const db = getDb();
    await db
      .update(agreementWitness)
      .set({
        attestedVersionId: input.attestedVersionId,
        attestedAt: input.attestedAt,
        ipAddress: input.ipAddress,
        deviceInfo: input.deviceInfo as object | null,
      })
      .where(eq(agreementWitness.id, id));
  }
}
