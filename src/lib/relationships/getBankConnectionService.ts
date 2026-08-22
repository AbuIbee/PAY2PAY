import "server-only";
import { getMfaService } from "@/lib/auth/getMfaService";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { BankConnectionService } from "./bankConnectionService";
import { getRelationshipFinancialAccountService } from "./getRelationshipFinancialAccountService";

let cached: BankConnectionService | null = null;

/** Lazily creates (and memoizes) the production BankConnectionService. Reuses the same PaymentProvider payments/ACH already resolve through — no separate provider registry entry for bank-linking. */
export function getBankConnectionService(): BankConnectionService {
  if (!cached) {
    cached = new BankConnectionService({
      provider: getPaymentProvider(),
      financialAccounts: getRelationshipFinancialAccountService(),
      mfa: getMfaService(),
    });
  }
  return cached;
}
