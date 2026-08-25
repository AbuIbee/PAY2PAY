import "server-only";
import { getAgreementService } from "./getAgreementService";
import { DrizzlePersonalProfileRepository } from "@/lib/auth/drizzlePersonalProfileRepository";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import { AgreementProgressService } from "./agreementProgressService";

let cached: AgreementProgressService | null = null;

/** Lazily creates (and memoizes) the production AgreementProgressService. Mirrors getSignatureService.ts's pattern. */
export function getAgreementProgressService(): AgreementProgressService {
  if (!cached) {
    cached = new AgreementProgressService({
      agreementService: getAgreementService(),
      verification: getVerificationService(),
      personalProfiles: new DrizzlePersonalProfileRepository(),
      relationshipPaymentMethods: getRelationshipFinancialAccountService(),
    });
  }
  return cached;
}
