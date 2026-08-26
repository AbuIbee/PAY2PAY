import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, installmentScheduleItem } from "@/db/schema";
import type { AgreementInstallmentStatusReader, InstallmentWithStatus } from "./agreementProgressService";

/**
 * Restore agreement payment functionality (Step 3/Step 5 truthful readiness): the existing
 * `InstallmentScheduleItemRepository.listForVersion` (AgreementService's own schedule-replacement
 * interface) deliberately never returns `installment_schedule_item.status` — every existing caller
 * only ever needs the projected schedule shape, never live paid/past_due state. This is a separate,
 * narrow, read-only reader for that live status, keyed by agreementId (not versionId) since every
 * consumer of "what's the next payment due" only ever has the agreement id — resolving
 * `agreement.current_version_id` is this reader's own job, not the caller's.
 */
export class DrizzleAgreementInstallmentStatusReader implements AgreementInstallmentStatusReader {
  async listForAgreement(agreementId: string): Promise<InstallmentWithStatus[]> {
    const db = getDb();
    const [agreementRow] = await db
      .select({ currentVersionId: agreement.currentVersionId })
      .from(agreement)
      .where(eq(agreement.id, agreementId))
      .limit(1);
    if (!agreementRow?.currentVersionId) return [];

    const rows = await db
      .select({
        id: installmentScheduleItem.id,
        sequenceNumber: installmentScheduleItem.sequenceNumber,
        dueDate: installmentScheduleItem.dueDate,
        amountMinorUnits: installmentScheduleItem.amountMinorUnits,
        status: installmentScheduleItem.status,
      })
      .from(installmentScheduleItem)
      .where(eq(installmentScheduleItem.agreementVersionId, agreementRow.currentVersionId))
      .orderBy(installmentScheduleItem.sequenceNumber);
    return rows;
  }
}
