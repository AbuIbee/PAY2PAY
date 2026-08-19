import "server-only";
import { eq, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { financialAccount } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  BankAccountSubtype,
  FinancialAccountRecord,
  FinancialAccountRepository,
  FinancialAccountType,
  FinancialAccountStatus,
} from "./relationshipFinancialAccountService";

type Row = typeof financialAccount.$inferSelect;

function toRecord(row: Row): FinancialAccountRecord {
  return {
    id: row.id,
    individualProfileId: row.individualProfileId,
    organizationId: row.organizationId,
    accountType: row.accountType as FinancialAccountType,
    providerName: row.providerName,
    providerAccountRef: row.providerAccountRef,
    maskedLast4: row.maskedLast4,
    institutionDisplayName: row.institutionDisplayName,
    cardExpiryMonth: row.cardExpiryMonth,
    cardExpiryYear: row.cardExpiryYear,
    cardBrand: row.cardBrand,
    bankAccountSubtype: row.bankAccountSubtype as BankAccountSubtype | null,
    status: row.status as FinancialAccountStatus,
    addedByUserId: row.addedByUserId,
    createdAt: row.createdAt,
    verifiedAt: row.verifiedAt,
    disabledAt: row.disabledAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleFinancialAccountRepository implements FinancialAccountRepository {
  async insert(input: {
    individualProfileId: string | null;
    organizationId: string | null;
    accountType: FinancialAccountType;
    providerName: string;
    providerAccountRef: string;
    maskedLast4: string | null;
    institutionDisplayName: string | null;
    cardExpiryMonth: number | null;
    cardExpiryYear: number | null;
    cardBrand: string | null;
    bankAccountSubtype: BankAccountSubtype | null;
    addedByUserId: string;
  }): Promise<FinancialAccountRecord> {
    const db = getDb();
    const [row] = await db.insert(financialAccount).values(input).returning();
    if (!row) throw new ConfigurationError("financial_account insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<FinancialAccountRecord | null> {
    const db = getDb();
    const rows = await db.select().from(financialAccount).where(eq(financialAccount.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForParty(individualProfileId: string | null, organizationId: string | null): Promise<FinancialAccountRecord[]> {
    const db = getDb();
    const conditions = [];
    if (individualProfileId) conditions.push(eq(financialAccount.individualProfileId, individualProfileId));
    if (organizationId) conditions.push(eq(financialAccount.organizationId, organizationId));
    if (conditions.length === 0) return [];
    const rows = await db.select().from(financialAccount).where(or(...conditions));
    return rows.map(toRecord);
  }

  async markVerified(id: string, verifiedAt: Date): Promise<FinancialAccountRecord> {
    const db = getDb();
    const [row] = await db
      .update(financialAccount)
      .set({ status: "verified", verifiedAt, updatedAt: new Date() })
      .where(eq(financialAccount.id, id))
      .returning();
    if (!row) throw new ConfigurationError("financial_account markVerified found no row");
    return toRecord(row);
  }

  async markFailed(id: string): Promise<FinancialAccountRecord> {
    const db = getDb();
    const [row] = await db
      .update(financialAccount)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(financialAccount.id, id))
      .returning();
    if (!row) throw new ConfigurationError("financial_account markFailed found no row");
    return toRecord(row);
  }

  async markDisabled(id: string, disabledAt: Date): Promise<FinancialAccountRecord> {
    const db = getDb();
    const [row] = await db
      .update(financialAccount)
      .set({ status: "disabled", disabledAt, updatedAt: new Date() })
      .where(eq(financialAccount.id, id))
      .returning();
    if (!row) throw new ConfigurationError("financial_account markDisabled found no row");
    return toRecord(row);
  }
}
