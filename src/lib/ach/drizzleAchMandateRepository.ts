import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { achMandate } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AchMandateRecord, AchMandateRepository } from "./achMandateService";

type Row = typeof achMandate.$inferSelect;

function toRecord(row: Row): AchMandateRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    payerProfileKind: row.payerProfileKind,
    payerProfileId: row.payerProfileId,
    bankAccountRef: row.bankAccountRef,
    status: row.status,
    authorizedAt: row.authorizedAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    supersedesMandateId: row.supersedesMandateId,
    createdAt: row.createdAt,
  };
}

export class DrizzleAchMandateRepository implements AchMandateRepository {
  async insert(input: {
    agreementId: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    bankAccountRef: string;
    supersedesMandateId: string | null;
  }): Promise<AchMandateRecord> {
    const db = getDb();
    const [row] = await db.insert(achMandate).values(input).returning();
    if (!row) throw new ConfigurationError("ach_mandate insert returned no row");
    return toRecord(row);
  }

  async findActiveForAgreement(agreementId: string): Promise<AchMandateRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(achMandate)
      .where(and(eq(achMandate.agreementId, agreementId), eq(achMandate.status, "active")))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<AchMandateRecord | null> {
    const db = getDb();
    const rows = await db.select().from(achMandate).where(eq(achMandate.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markRevoked(id: string, revokedAt: Date, revokedReason: string): Promise<AchMandateRecord> {
    const db = getDb();
    const [row] = await db
      .update(achMandate)
      .set({ status: "revoked", revokedAt, revokedReason })
      .where(eq(achMandate.id, id))
      .returning();
    if (!row) throw new ConfigurationError("ach_mandate markRevoked found no row");
    return toRecord(row);
  }
}
