import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, installmentScheduleItem } from "@/db/schema";
import type { AgreementScheduleReader } from "./paymentService";

/**
 * R11 (Final Open Issue A — ORDINARY-PAYMENT LINKAGE REQUIREMENT): real implementation of
 * `AgreementScheduleReader` — see that interface's own doc comment in paymentService.ts.
 */
export class DrizzleAgreementScheduleReader implements AgreementScheduleReader {
  async hasInstallmentSchedule(agreementId: string): Promise<boolean> {
    const db = getDb();
    const agreementRows = await db.select({ currentVersionId: agreement.currentVersionId }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    const currentVersionId = agreementRows[0]?.currentVersionId;
    if (!currentVersionId) return false;
    const rows = await db.select({ id: installmentScheduleItem.id }).from(installmentScheduleItem).where(eq(installmentScheduleItem.agreementVersionId, currentVersionId)).limit(1);
    return rows.length > 0;
  }
}
