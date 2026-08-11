import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementVersion } from "@/db/schema";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import type { AgreementTermsReader } from "./balanceService";

export class DrizzleAgreementTermsReader implements AgreementTermsReader {
  async getPrincipal(agreementId: string): Promise<{ principalMinorUnits: number; currency: string } | null> {
    const db = getDb();
    const agreementRows = await db
      .select({ currentVersionId: agreement.currentVersionId, currency: agreement.currency })
      .from(agreement)
      .where(eq(agreement.id, agreementId))
      .limit(1);
    const agreementRow = agreementRows[0];
    if (!agreementRow || !agreementRow.currentVersionId) return null;

    const versionRows = await db
      .select({ terms: agreementVersion.terms })
      .from(agreementVersion)
      .where(eq(agreementVersion.id, agreementRow.currentVersionId))
      .limit(1);
    const versionRow = versionRows[0];
    if (!versionRow) return null;

    const terms = versionRow.terms as AgreementTerms;
    return { principalMinorUnits: terms.currentPrincipalMinorUnits, currency: agreementRow.currency };
  }
}
