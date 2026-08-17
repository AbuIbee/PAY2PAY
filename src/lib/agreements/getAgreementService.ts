import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { AgreementService } from "./agreementService";
import { DrizzleAgreementPartyRepository } from "./drizzleAgreementPartyRepository";
import { DrizzleAgreementRepository } from "./drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "./drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "./drizzleInstallmentScheduleItemRepository";
import { DrizzleSigningApplicationRepository } from "./drizzleSigningApplicationRepository";

let cached: AgreementService | null = null;

/** Lazily creates (and memoizes) the production AgreementService. Mirrors getAuthService.ts's pattern. */
export function getAgreementService(): AgreementService {
  if (!cached) {
    cached = new AgreementService({
      agreements: new DrizzleAgreementRepository(),
      versions: new DrizzleAgreementVersionRepository(),
      parties: new DrizzleAgreementPartyRepository(),
      scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      signing: new DrizzleSigningApplicationRepository(),
    });
  }
  return cached;
}
