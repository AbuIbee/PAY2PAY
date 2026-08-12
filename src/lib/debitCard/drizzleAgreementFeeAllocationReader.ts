import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementVersion } from "@/db/schema";
import type { AgreementFeeAllocationReader, FeeAllocation } from "./agreementFeeAllocationReader";

/** Mirrors src/lib/ledger/drizzleAgreementTermsReader.ts's agreement -> current agreement_version join exactly. */
export class DrizzleAgreementFeeAllocationReader implements AgreementFeeAllocationReader {
  async getFeeAllocation(agreementId: string): Promise<FeeAllocation | null> {
    const db = getDb();
    const agreementRows = await db
      .select({ currentVersionId: agreement.currentVersionId })
      .from(agreement)
      .where(eq(agreement.id, agreementId))
      .limit(1);
    const agreementRow = agreementRows[0];
    if (!agreementRow || !agreementRow.currentVersionId) return null;

    const versionRows = await db
      .select({ feeAllocation: agreementVersion.feeAllocation })
      .from(agreementVersion)
      .where(eq(agreementVersion.id, agreementRow.currentVersionId))
      .limit(1);
    return versionRows[0]?.feeAllocation ?? null;
  }
}
