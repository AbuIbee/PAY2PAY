import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { AchMandateService } from "./achMandateService";
import { DrizzleAchMandateRepository } from "./drizzleAchMandateRepository";

let cached: AchMandateService | null = null;

export function getAchMandateService(): AchMandateService {
  if (!cached) {
    cached = new AchMandateService({
      mandates: new DrizzleAchMandateRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      // R08 B1 (ACH-1): narrow read-only dependency — never AgreementService, never a second DB client.
      agreements: new DrizzleAgreementRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
