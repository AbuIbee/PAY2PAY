import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, personalProfile, userAccount } from "@/db/schema";
import type { ExistingAgreementDuplicateChecker } from "./csvImportService";

export class DrizzleExistingAgreementDuplicateChecker implements ExistingAgreementDuplicateChecker {
  async hasExistingAgreement(businessProfileId: string, debtorEmail: string): Promise<boolean> {
    const db = getDb();
    const userRows = await db.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.email, debtorEmail)).limit(1);
    const user = userRows[0];
    if (!user) return false;

    const profileRows = await db
      .select({ id: personalProfile.id })
      .from(personalProfile)
      .where(eq(personalProfile.userId, user.id))
      .limit(1);
    const profile = profileRows[0];
    if (!profile) return false;

    const rows = await db
      .select({ id: agreement.id })
      .from(agreement)
      .where(
        and(
          eq(agreement.creditorProfileKind, "business"),
          eq(agreement.creditorProfileId, businessProfileId),
          eq(agreement.debtorProfileKind, "personal"),
          eq(agreement.debtorProfileId, profile.id),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
