import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementVersionRepository } from "@/lib/agreements/drizzleAgreementVersionRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AmendmentService } from "./amendmentService";
import { DrizzleAmendmentApplicationRepository } from "./drizzleAmendmentApplicationRepository";
import { DrizzleAmendmentRepository } from "./drizzleAmendmentRepository";

let cached: AmendmentService | null = null;

export function getAmendmentService(): AmendmentService {
  if (!cached) {
    cached = new AmendmentService({
      agreementService: getAgreementService(),
      amendments: new DrizzleAmendmentRepository(),
      versions: new DrizzleAgreementVersionRepository(),
      application: new DrizzleAmendmentApplicationRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
