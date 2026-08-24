import "server-only";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { financialAccount, relationshipFinancialAccount } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  BankAccountSubtype,
  FinancialAccountRecord,
  FinancialAccountType,
  FinancialAccountStatus,
  RelationshipFinancialAccountAssignmentRecord,
  RelationshipFinancialAccountAssignmentStatus,
  RelationshipFinancialAccountAssignmentWithAccount,
  RelationshipFinancialAccountRepository,
  FinancialAccountUsage,
} from "./relationshipFinancialAccountService";

type AssignmentRow = typeof relationshipFinancialAccount.$inferSelect;
type AccountRow = typeof financialAccount.$inferSelect;

function toAssignmentRecord(row: AssignmentRow): RelationshipFinancialAccountAssignmentRecord {
  return {
    id: row.id,
    relationshipId: row.relationshipId,
    relationshipParticipantId: row.relationshipParticipantId,
    financialAccountId: row.financialAccountId,
    usage: row.usage as FinancialAccountUsage,
    status: row.status as RelationshipFinancialAccountAssignmentStatus,
    selectedByUserId: row.selectedByUserId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    supersededBy: row.supersededBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAccountRecord(row: AccountRow): FinancialAccountRecord {
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

export class DrizzleRelationshipFinancialAccountRepository implements RelationshipFinancialAccountRepository {
  async insertAssignment(input: {
    id?: string;
    relationshipId: string;
    relationshipParticipantId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
    selectedByUserId: string;
  }): Promise<RelationshipFinancialAccountAssignmentRecord> {
    const db = getDb();
    const [row] = await db.insert(relationshipFinancialAccount).values(input).returning();
    if (!row) throw new ConfigurationError("relationship_financial_account insert returned no row");
    return toAssignmentRecord(row);
  }

  async findActiveAssignment(relationshipId: string, usage: FinancialAccountUsage): Promise<RelationshipFinancialAccountAssignmentWithAccount | null> {
    const db = getDb();
    const rows = await db
      .select({ assignment: relationshipFinancialAccount, account: financialAccount })
      .from(relationshipFinancialAccount)
      .innerJoin(financialAccount, eq(financialAccount.id, relationshipFinancialAccount.financialAccountId))
      .where(
        and(
          eq(relationshipFinancialAccount.relationshipId, relationshipId),
          eq(relationshipFinancialAccount.usage, usage),
          eq(relationshipFinancialAccount.status, "active"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...toAssignmentRecord(row.assignment), financialAccount: toAccountRecord(row.account) };
  }

  async markSuperseded(id: string, supersededBy: string): Promise<RelationshipFinancialAccountAssignmentRecord> {
    const db = getDb();
    const [row] = await db
      .update(relationshipFinancialAccount)
      .set({ status: "superseded", supersededBy, effectiveTo: new Date(), updatedAt: new Date() })
      .where(eq(relationshipFinancialAccount.id, id))
      .returning();
    if (!row) throw new ConfigurationError("relationship_financial_account markSuperseded found no row");
    return toAssignmentRecord(row);
  }

  async listForRelationship(relationshipId: string): Promise<RelationshipFinancialAccountAssignmentWithAccount[]> {
    const db = getDb();
    const rows = await db
      .select({ assignment: relationshipFinancialAccount, account: financialAccount })
      .from(relationshipFinancialAccount)
      .innerJoin(financialAccount, eq(financialAccount.id, relationshipFinancialAccount.financialAccountId))
      .where(eq(relationshipFinancialAccount.relationshipId, relationshipId));
    return rows.map((r) => ({ ...toAssignmentRecord(r.assignment), financialAccount: toAccountRecord(r.account) }));
  }

  async listActiveAssignmentsForAccount(financialAccountId: string): Promise<RelationshipFinancialAccountAssignmentRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(relationshipFinancialAccount)
      .where(
        and(
          eq(relationshipFinancialAccount.financialAccountId, financialAccountId),
          eq(relationshipFinancialAccount.status, "active"),
        ),
      );
    return rows.map(toAssignmentRecord);
  }
}
