import "server-only";
import { getDb } from "@/db/client";
import { computeInstallmentSettlementWithinTx } from "./installmentSettlementTx";
import type { InstallmentSettlementComputer } from "./reconciliationService";

/** R11 (HISTORICAL DATA, §9): real implementation of `InstallmentSettlementComputer` — see that interface's own doc comment. */
export class DrizzleInstallmentSettlementComputer implements InstallmentSettlementComputer {
  async computeSettlement(installmentScheduleItemId: string) {
    const db = getDb();
    return db.transaction((tx) => computeInstallmentSettlementWithinTx(tx, installmentScheduleItemId));
  }
}
