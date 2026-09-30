import "server-only";
import { BalanceService } from "./balanceService";
import { DrizzleAgreementTermsReader } from "./drizzleAgreementTermsReader";
import { DrizzleSettlementBalanceReader } from "./drizzleSettlementBalanceReader";
import { getLedgerService } from "./getLedgerService";

let cached: BalanceService | null = null;

export function getBalanceService(): BalanceService {
  if (!cached) {
    cached = new BalanceService({
      ledger: getLedgerService(),
      terms: new DrizzleAgreementTermsReader(),
      settlementBalance: new DrizzleSettlementBalanceReader(),
    });
  }
  return cached;
}
