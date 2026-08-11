import "server-only";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "@/lib/agreements/drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "@/lib/agreements/drizzleInstallmentScheduleItemRepository";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzlePersonalProfileRepository } from "@/lib/auth/drizzlePersonalProfileRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { DrizzleAgreementWitnessRepository } from "./drizzleAgreementWitnessRepository";
import { WitnessService } from "./witnessService";

let cached: WitnessService | null = null;

/** Lazily creates (and memoizes) the production WitnessService. Mirrors getSignatureService.ts's pattern. */
export function getWitnessService(): WitnessService {
  if (!cached) {
    cached = new WitnessService({
      agreementService: getAgreementService(),
      witnesses: new DrizzleAgreementWitnessRepository(),
      agreements: new DrizzleAgreementRepository(),
      versions: new DrizzleAgreementVersionRepository(),
      scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
      personalProfiles: new DrizzlePersonalProfileRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      verification: getVerificationService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
