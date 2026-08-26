import "server-only";
import { getAgreementService } from "./getAgreementService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import { DrizzleAgreementCancellationReader } from "./drizzleAgreementCancellationReader";
import { AgreementProgressService } from "./agreementProgressService";

let cached: AgreementProgressService | null = null;

/** Lazily creates (and memoizes) the production AgreementProgressService. Mirrors getSignatureService.ts's pattern. */
export function getAgreementProgressService(): AgreementProgressService {
  if (!cached) {
    cached = new AgreementProgressService({
      agreementService: getAgreementService(),
      relationshipPaymentMethods: getRelationshipFinancialAccountService(),
      cancellation: new DrizzleAgreementCancellationReader(),
    });
  }
  return cached;
}
