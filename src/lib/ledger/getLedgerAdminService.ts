import "server-only";
import { getBalanceService } from "./getBalanceService";
import { getLedgerService } from "./getLedgerService";
import { getReconciliationService } from "./getReconciliationService";
import { LedgerAdminService } from "./ledgerAdminService";

let cached: LedgerAdminService | null = null;

export function getLedgerAdminService(): LedgerAdminService {
  if (!cached) {
    cached = new LedgerAdminService({
      ledger: getLedgerService(),
      balance: getBalanceService(),
      reconciliation: getReconciliationService(),
    });
  }
  return cached;
}
