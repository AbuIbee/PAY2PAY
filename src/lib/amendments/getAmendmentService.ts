import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "@/lib/agreements/drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "@/lib/agreements/drizzleInstallmentScheduleItemRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AmendmentService } from "./amendmentService";
import { DrizzleAmendmentRepository } from "./drizzleAmendmentRepository";

let cached: AmendmentService | null = null;

export function getAmendmentService(): AmendmentService {
  if (!cached) {
    cached = new AmendmentService({
      agreementService: getAgreementService(),
      amendments: new DrizzleAmendmentRepository(),
      versions: new DrizzleAgreementVersionRepository(),
      agreements: new DrizzleAgreementRepository(),
      scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
