import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { bankLinkAttempt } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/payments/paymentProvider";
import type { BankLinkAttemptRecord, BankLinkAttemptRepository, BankLinkAttemptStatus } from "./bankLinkAttemptRepository";

type Row = typeof bankLinkAttempt.$inferSelect;

function toRecord(row: Row): BankLinkAttemptRecord {
  return {
    id: row.id,
    providerSessionId: row.providerSessionId,
    merchantReference: row.merchantReference,
    actingUserId: row.actingUserId,
    partyProfileKind: row.partyProfileKind as ProfileKind,
    partyIndividualProfileId: row.partyIndividualProfileId,
    partyOrganizationId: row.partyOrganizationId,
    shopperReference: row.shopperReference,
    institutionDisplayName: row.institutionDisplayName,
    confirmedPspReference: row.confirmedPspReference,
    status: row.status as BankLinkAttemptStatus,
    resultFinancialAccountId: row.resultFinancialAccountId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    confirmedAt: row.confirmedAt,
    completedAt: row.completedAt,
  };
}

export class DrizzleBankLinkAttemptRepository implements BankLinkAttemptRepository {
  async insert(input: {
    providerSessionId: string;
    merchantReference: string;
    actingUserId: string;
    partyProfileKind: ProfileKind;
    partyIndividualProfileId: string | null;
    partyOrganizationId: string | null;
    shopperReference: string;
    institutionDisplayName: string | null;
    expiresAt: Date;
  }): Promise<BankLinkAttemptRecord> {
    const db = getDb();
    const [row] = await db.insert(bankLinkAttempt).values(input).returning();
    if (!row) throw new ConfigurationError("bank_link_attempt insert returned no row");
    return toRecord(row);
  }

  async findByProviderSessionId(providerSessionId: string): Promise<BankLinkAttemptRecord | null> {
    const db = getDb();
    const rows = await db.select().from(bankLinkAttempt).where(eq(bankLinkAttempt.providerSessionId, providerSessionId)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByMerchantReference(merchantReference: string): Promise<BankLinkAttemptRecord | null> {
    const db = getDb();
    const rows = await db.select().from(bankLinkAttempt).where(eq(bankLinkAttempt.merchantReference, merchantReference)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByConfirmedPspReference(pspReference: string): Promise<BankLinkAttemptRecord | null> {
    const db = getDb();
    const rows = await db.select().from(bankLinkAttempt).where(eq(bankLinkAttempt.confirmedPspReference, pspReference)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markAuthorised(id: string, confirmedPspReference: string, confirmedAt: Date): Promise<BankLinkAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(bankLinkAttempt)
      .set({ status: "authorised", confirmedPspReference, confirmedAt })
      .where(eq(bankLinkAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("bank_link_attempt markAuthorised found no row");
    return toRecord(row);
  }

  async markCompleted(id: string, resultFinancialAccountId: string, completedAt: Date): Promise<BankLinkAttemptRecord> {
    const db = getDb();
    const [row] = await db
      .update(bankLinkAttempt)
      .set({ status: "completed", resultFinancialAccountId, completedAt })
      .where(eq(bankLinkAttempt.id, id))
      .returning();
    if (!row) throw new ConfigurationError("bank_link_attempt markCompleted found no row");
    return toRecord(row);
  }

  async markFailed(id: string): Promise<BankLinkAttemptRecord> {
    const db = getDb();
    const [row] = await db.update(bankLinkAttempt).set({ status: "failed" }).where(eq(bankLinkAttempt.id, id)).returning();
    if (!row) throw new ConfigurationError("bank_link_attempt markFailed found no row");
    return toRecord(row);
  }
}
