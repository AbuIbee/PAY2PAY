import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, installmentScheduleItem } from "@/db/schema";
import { computeInstallmentSettlementWithinTx } from "./installmentSettlementTx";
import type { AgreementInstallmentSatisfactionChecker } from "./agreementCompletionService";

/**
 * R11: real implementation of `AgreementInstallmentSatisfactionChecker` — see that interface's own
 * doc comment. Unlocked (mirrors `BalanceService.getAgreementBalance`'s own unlocked-read precedent)
 * — `checkAndAdvance` itself is not transactional against a single installment lock either; the
 * authoritative, LOCKED equivalent for the supersession-recompute path is
 * `AgreementCompletionService.computeFreshEvidenceWithinTx`'s own tx-bound loop, not this reader.
 */
export class DrizzleAgreementInstallmentSatisfactionReader implements AgreementInstallmentSatisfactionChecker {
  async areAllNonWaivedInstallmentsSatisfied(agreementId: string): Promise<boolean> {
    const db = getDb();
    const agreementRows = await db.select({ currentVersionId: agreement.currentVersionId }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    const currentVersionId = agreementRows[0]?.currentVersionId;
    if (!currentVersionId) return true; // no signed version — nothing to check; the aggregate-balance check upstream already handles this case.

    const items = await db
      .select({ id: installmentScheduleItem.id, status: installmentScheduleItem.status })
      .from(installmentScheduleItem)
      .where(eq(installmentScheduleItem.agreementVersionId, currentVersionId));

    for (const item of items) {
      if (item.status === "waived") continue;
      const settlement = await db.transaction((tx) => computeInstallmentSettlementWithinTx(tx, item.id));
      if (!settlement || !settlement.isSatisfied) return false;
    }
    return true;
  }
}
