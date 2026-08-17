import "server-only";
import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, businessProfile, businessStaffMember, userAccount } from "@/db/schema";
import type { AdminBusinessDetail, AdminBusinessDirectoryReader, AdminBusinessSummary } from "./adminService";

/**
 * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md): read-only
 * admin queries only — mirrors DrizzleAdminUserDirectoryReader's own doc comment and shape exactly,
 * just for `business_profile` instead of `user_account`. Never imported by anything that could grant
 * this class write access to `agreement`/`agreement_version`/etc.
 */
export class DrizzleAdminBusinessDirectoryReader implements AdminBusinessDirectoryReader {
  async search(query: { name?: string; businessId?: string }): Promise<AdminBusinessSummary[]> {
    if (query.businessId) {
      return this.selectSummaries(eq(businessProfile.id, query.businessId));
    }
    if (query.name) {
      return this.selectSummaries(
        or(ilike(businessProfile.displayName, `%${query.name}%`), ilike(businessProfile.legalBusinessName, `%${query.name}%`)),
      );
    }
    return this.selectSummaries(undefined);
  }

  async getSummary(businessId: string): Promise<AdminBusinessSummary | null> {
    const rows = await this.selectSummaries(eq(businessProfile.id, businessId));
    return rows[0] ?? null;
  }

  async getDetail(businessId: string): Promise<AdminBusinessDetail | null> {
    const db = getDb();
    const summary = await this.getSummary(businessId);
    if (!summary) return null;

    const businessRows = await db
      .select({ entityType: businessProfile.entityType, country: businessProfile.country, state: businessProfile.state })
      .from(businessProfile)
      .where(eq(businessProfile.id, businessId))
      .limit(1);
    const businessRow = businessRows[0];
    if (!businessRow) return null;

    const memberRows = await db
      .select({
        userId: businessStaffMember.userId,
        email: userAccount.email,
        role: businessStaffMember.role,
        isAuthorizedRepresentative: businessStaffMember.isAuthorizedRepresentative,
      })
      .from(businessStaffMember)
      .innerJoin(userAccount, eq(userAccount.id, businessStaffMember.userId))
      .where(and(eq(businessStaffMember.businessProfileId, businessId), isNull(businessStaffMember.removedAt)));

    const agreementRows = await db
      .select({ id: agreement.id, status: agreement.status, creditorProfileKind: agreement.creditorProfileKind, debtorProfileKind: agreement.debtorProfileKind })
      .from(agreement)
      .where(
        or(
          and(eq(agreement.creditorProfileKind, "business"), eq(agreement.creditorProfileId, businessId)),
          and(eq(agreement.debtorProfileKind, "business"), eq(agreement.debtorProfileId, businessId)),
        ),
      );

    return {
      ...summary,
      entityType: businessRow.entityType,
      country: businessRow.country,
      state: businessRow.state,
      members: memberRows,
      agreements: agreementRows.map((row) => ({
        id: row.id,
        status: row.status,
        relationshipShape:
          row.creditorProfileKind === "personal" && row.debtorProfileKind === "personal"
            ? "P2P"
            : row.creditorProfileKind === "business" && row.debtorProfileKind === "personal"
              ? "B2C"
              : row.creditorProfileKind === "personal" && row.debtorProfileKind === "business"
                ? "C2B"
                : "B2B",
      })),
    };
  }

  /** Shared owner-joined summary query — every AdminBusinessSummary needs the owner's email/platformRole (authorizeMutableBusinessTarget's own basis for its authorization decision), so this is never selected without the join. */
  private async selectSummaries(whereClause: SQL | undefined): Promise<AdminBusinessSummary[]> {
    const db = getDb();
    const base = db
      .select({
        id: businessProfile.id,
        legalBusinessName: businessProfile.legalBusinessName,
        displayName: businessProfile.displayName,
        status: businessProfile.status,
        ownerUserId: businessProfile.ownerUserId,
        ownerEmail: userAccount.email,
        ownerPlatformRole: userAccount.platformRole,
        createdAt: businessProfile.createdAt,
      })
      .from(businessProfile)
      .innerJoin(userAccount, eq(userAccount.id, businessProfile.ownerUserId));
    const rows = whereClause ? await base.where(whereClause).limit(20) : await base.limit(20);
    return rows;
  }
}
