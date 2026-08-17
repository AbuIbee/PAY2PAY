import "server-only";
import { and, eq, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, businessProfile, personalProfile, userAccount } from "@/db/schema";
import { summarizeAgreementsForAdmin } from "./adminAgreementSummary";
import type { AdminUserDetail, AdminUserDirectoryReader, AdminUserSummary } from "./adminService";

type UserAccountRow = typeof userAccount.$inferSelect;

function toSummary(row: UserAccountRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    platformRole: row.platformRole,
    accountClassification: row.accountClassification,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

/**
 * Sprint 6A: read-only admin queries only — never imported by anything that could grant this class
 * write access to `agreement`/`agreement_version`/etc.; it only ever SELECTs from `agreement` to
 * list which agreements a user is a party to, exactly like the ordinary user-facing
 * DrizzleAgreementRepository.listForProfile does for a single profile — just resolved from a
 * user_account id across all of that user's profiles first.
 */
export class DrizzleAdminUserDirectoryReader implements AdminUserDirectoryReader {
  async search(query: { email?: string; userId?: string }): Promise<AdminUserSummary[]> {
    const db = getDb();
    if (query.userId) {
      const rows = await db.select().from(userAccount).where(eq(userAccount.id, query.userId)).limit(20);
      return rows.map(toSummary);
    }
    if (query.email) {
      const rows = await db
        .select()
        .from(userAccount)
        .where(eq(userAccount.email, query.email.trim().toLowerCase()))
        .limit(20);
      return rows.map(toSummary);
    }
    const rows = await db.select().from(userAccount).limit(20);
    return rows.map(toSummary);
  }

  async getSummary(userId: string): Promise<AdminUserSummary | null> {
    const db = getDb();
    const rows = await db.select().from(userAccount).where(eq(userAccount.id, userId)).limit(1);
    const row = rows[0];
    return row ? toSummary(row) : null;
  }

  async getDetail(userId: string): Promise<AdminUserDetail | null> {
    const db = getDb();
    const userRows = await db.select().from(userAccount).where(eq(userAccount.id, userId)).limit(1);
    const userRow = userRows[0];
    if (!userRow) return null;

    const [personalRows, businessRows] = await Promise.all([
      db.select({ id: personalProfile.id }).from(personalProfile).where(eq(personalProfile.userId, userId)).limit(1),
      db
        .select({ id: businessProfile.id, displayName: businessProfile.displayName, status: businessProfile.status })
        .from(businessProfile)
        .where(eq(businessProfile.ownerUserId, userId)),
    ]);

    const personalProfileId = personalRows[0]?.id ?? null;
    const ownedProfileConditions = [
      ...(personalProfileId
        ? [
            and(eq(agreement.creditorProfileKind, "personal"), eq(agreement.creditorProfileId, personalProfileId)),
            and(eq(agreement.debtorProfileKind, "personal"), eq(agreement.debtorProfileId, personalProfileId)),
          ]
        : []),
      ...businessRows.flatMap((business) => [
        and(eq(agreement.creditorProfileKind, "business"), eq(agreement.creditorProfileId, business.id)),
        and(eq(agreement.debtorProfileKind, "business"), eq(agreement.debtorProfileId, business.id)),
      ]),
    ];

    const agreementRows =
      ownedProfileConditions.length > 0
        ? await db
            .select({
              id: agreement.id,
              status: agreement.status,
              creditorProfileKind: agreement.creditorProfileKind,
              debtorProfileKind: agreement.debtorProfileKind,
              currentVersionId: agreement.currentVersionId,
            })
            .from(agreement)
            .where(or(...ownedProfileConditions))
        : [];

    return {
      ...toSummary(userRow),
      emailVerifiedAt: userRow.emailVerifiedAt,
      personalProfileId,
      businessProfiles: businessRows,
      agreements: await summarizeAgreementsForAdmin(agreementRows),
    };
  }
}
