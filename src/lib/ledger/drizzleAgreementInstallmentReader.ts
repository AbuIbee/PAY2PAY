import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, installmentScheduleItem } from "@/db/schema";
import type { AgreementInstallmentReader } from "./reconciliationService";

/** R11 (HISTORICAL DATA, §9): real implementation of `AgreementInstallmentReader` — see that interface's own doc comment. */
export class DrizzleAgreementInstallmentReader implements AgreementInstallmentReader {
  async listForAgreement(agreementId: string): Promise<{ id: string; amountMinorUnits: number; status: string }[]> {
    const db = getDb();
    const agreementRows = await db.select({ currentVersionId: agreement.currentVersionId }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    const currentVersionId = agreementRows[0]?.currentVersionId;
    if (!currentVersionId) return [];
    return db
      .select({ id: installmentScheduleItem.id, amountMinorUnits: installmentScheduleItem.amountMinorUnits, status: installmentScheduleItem.status })
      .from(installmentScheduleItem)
      .where(eq(installmentScheduleItem.agreementVersionId, currentVersionId));
  }
}
