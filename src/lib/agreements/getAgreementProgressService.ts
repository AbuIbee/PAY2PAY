import "server-only";
import { getAgreementService } from "./getAgreementService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import { getBalanceService } from "@/lib/ledger/getBalanceService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzleAgreementCancellationReader } from "./drizzleAgreementCancellationReader";
import { DrizzleAgreementInstallmentStatusReader } from "./drizzleAgreementInstallmentStatusReader";
import { DrizzleAgreementInstallmentSettlementReader } from "./drizzleAgreementInstallmentSettlementReader";
import { AgreementProgressService } from "./agreementProgressService";

let cached: AgreementProgressService | null = null;

/** Lazily creates (and memoizes) the production AgreementProgressService. Mirrors getSignatureService.ts's pattern. */
export function getAgreementProgressService(): AgreementProgressService {
  if (!cached) {
    cached = new AgreementProgressService({
      agreementService: getAgreementService(),
      relationshipPaymentMethods: getRelationshipFinancialAccountService(),
      cancellation: new DrizzleAgreementCancellationReader(),
      mandates: getAchMandateService(),
      installments: new DrizzleAgreementInstallmentStatusReader(),
      paymentAttempts: new DrizzlePaymentAttemptRepository(),
      balance: getBalanceService(),
      partyAccounts: getRelationshipFinancialAccountService(),
      // R11 PASS B1 (Defect B1-3): see `AgreementProgressServiceDeps.installmentSettlements`'s own doc
      // comment — the SAME authoritative reader `/api/agreements/payment-setup/next-payment` uses.
      installmentSettlements: new DrizzleAgreementInstallmentSettlementReader(),
    });
  }
  return cached;
}
