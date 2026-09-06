import "server-only";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { financialAccount, relationshipFinancialAccount } from "@/db/schema";
import { ConfigurationError, ConflictError } from "@/lib/errors";
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
  /**
   * R07 corrective pass: `db` is injectable (defaulting to the shared production singleton) solely
   * so `*.postgres.test.ts` concurrency suites can hand two instances of this SAME class two
   * genuinely distinct PostgreSQL connections — proving real transaction overlap/lock contention,
   * which a single shared `max: 1` connection structurally cannot exhibit. Every production call
   * site (`new DrizzleRelationshipFinancialAccountRepository()`, no argument) is unaffected — it
   * still resolves to the identical memoized `getDb()` singleton it always has.
   */
  constructor(private readonly db: Database = getDb()) {}

  async insertAssignment(input: {
    id?: string;
    relationshipId: string;
    relationshipParticipantId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
    selectedByUserId: string;
  }): Promise<RelationshipFinancialAccountAssignmentRecord> {
    const db = this.db;
    const [row] = await db.insert(relationshipFinancialAccount).values(input).returning();
    if (!row) throw new ConfigurationError("relationship_financial_account insert returned no row");
    return toAssignmentRecord(row);
  }

  async findActiveAssignment(relationshipId: string, usage: FinancialAccountUsage): Promise<RelationshipFinancialAccountAssignmentWithAccount | null> {
    const db = this.db;
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
    const db = this.db;
    const [row] = await db
      .update(relationshipFinancialAccount)
      .set({ status: "superseded", supersededBy, effectiveTo: new Date(), updatedAt: new Date() })
      .where(eq(relationshipFinancialAccount.id, id))
      .returning();
    if (!row) throw new ConfigurationError("relationship_financial_account markSuperseded found no row");
    return toAssignmentRecord(row);
  }

  async listForRelationship(relationshipId: string): Promise<RelationshipFinancialAccountAssignmentWithAccount[]> {
    const db = this.db;
    const rows = await db
      .select({ assignment: relationshipFinancialAccount, account: financialAccount })
      .from(relationshipFinancialAccount)
      .innerJoin(financialAccount, eq(financialAccount.id, relationshipFinancialAccount.financialAccountId))
      .where(eq(relationshipFinancialAccount.relationshipId, relationshipId));
    return rows.map((r) => ({ ...toAssignmentRecord(r.assignment), financialAccount: toAccountRecord(r.account) }));
  }

  async listActiveAssignmentsForAccount(financialAccountId: string): Promise<RelationshipFinancialAccountAssignmentRecord[]> {
    const db = this.db;
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

  /**
   * R03 (DB integrity & concurrency hardening): supersede-old + insert-new in one transaction,
   * serialized by a transaction-scoped advisory lock keyed on (relationshipId, usage) — mirrors
   * DrizzleRelationshipPairResolver's identical `pg_advisory_xact_lock(hashtext(...), hashtext(...))`
   * precedent. `pg_advisory_xact_lock` (not `pg_advisory_lock`) is required because production
   * connects through Supabase's Supavisor transaction-mode pooler (src/db/client.ts), which does not
   * guarantee the same backend connection across statements outside a single transaction — a
   * session-level lock would be meaningless there.
   *
   * After acquiring the lock, re-reads the slot's actual current active assignment and compares it
   * to `expectedExistingId` — this is the authoritative check; the caller's own earlier
   * `findActiveAssignment` read (used for its ownership/authorization checks) is necessarily stale by
   * the time this transaction runs. A mismatch means a concurrent call already won this slot, and
   * throws `ConflictError` — the old row this caller expected is left exactly as it was (query-only,
   * no write happens on the losing path). On success, generating the new row's id up front lets the
   * old row be superseded-by-it FIRST, so at insert time exactly zero active rows exist for this slot
   * (the DB's own `relationship_financial_account_active_slot_unique` partial unique index would
   * otherwise briefly see two, even in the non-racing case).
   */
  async replaceAssignmentAtomically(input: {
    relationshipId: string;
    relationshipParticipantId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
    selectedByUserId: string;
    expectedExistingId: string | null;
  }): Promise<RelationshipFinancialAccountAssignmentRecord> {
    const db = this.db;
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.relationshipId}), hashtext(${input.usage}))`);

      const activeRows = await tx
        .select()
        .from(relationshipFinancialAccount)
        .where(
          and(
            eq(relationshipFinancialAccount.relationshipId, input.relationshipId),
            eq(relationshipFinancialAccount.usage, input.usage),
            eq(relationshipFinancialAccount.status, "active"),
          ),
        )
        .limit(1);
      const currentActive = activeRows[0] ?? null;
      const currentActiveId = currentActive?.id ?? null;
      if (currentActiveId !== input.expectedExistingId) {
        throw new ConflictError("relationship_financial_account slot was already replaced or assigned by a concurrent request");
      }

      const newAssignmentId = randomUUID();
      if (currentActive) {
        await tx
          .update(relationshipFinancialAccount)
          .set({ status: "superseded", supersededBy: newAssignmentId, effectiveTo: new Date(), updatedAt: new Date() })
          .where(eq(relationshipFinancialAccount.id, currentActive.id));
      }

      const [row] = await tx
        .insert(relationshipFinancialAccount)
        .values({
          id: newAssignmentId,
          relationshipId: input.relationshipId,
          relationshipParticipantId: input.relationshipParticipantId,
          financialAccountId: input.financialAccountId,
          usage: input.usage,
          selectedByUserId: input.selectedByUserId,
        })
        .returning();
      if (!row) throw new ConfigurationError("relationship_financial_account insert returned no row during atomic replacement");
      return toAssignmentRecord(row);
    });
  }
}
