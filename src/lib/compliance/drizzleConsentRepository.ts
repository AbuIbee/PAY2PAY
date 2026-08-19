import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { consentRecord } from "@/db/schema";
import type { ConsentPolicyType, ConsentRecord, ConsentRepository } from "./consentService";

type Row = typeof consentRecord.$inferSelect;

function toRecord(row: Row): ConsentRecord {
  return {
    id: row.id,
    userId: row.userId,
    policyType: row.policyType,
    policyVersion: row.policyVersion,
    consentedAt: row.consentedAt,
    method: row.method,
    ipAddress: row.ipAddress,
  };
}

export class DrizzleConsentRepository implements ConsentRepository {
  async insert(input: { userId: string; policyType: ConsentPolicyType; policyVersion: string; method: string; ipAddress: string | null }): Promise<ConsentRecord> {
    const db = getDb();
    const [row] = await db.insert(consentRecord).values(input).returning();
    return toRecord(row!);
  }

  async listForUser(userId: string): Promise<ConsentRecord[]> {
    const db = getDb();
    const rows = await db.select().from(consentRecord).where(eq(consentRecord.userId, userId)).orderBy(desc(consentRecord.consentedAt));
    return rows.map(toRecord);
  }
}
