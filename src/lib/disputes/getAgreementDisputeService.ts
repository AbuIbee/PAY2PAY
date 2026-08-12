import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { getAmendmentService } from "@/lib/amendments/getAmendmentService";
import { getEvidenceService } from "@/lib/evidence/getEvidenceService";
import { AgreementDisputeService } from "./agreementDisputeService";
import { DrizzleAgreementDisputeRepository } from "./drizzleAgreementDisputeRepository";

let cached: AgreementDisputeService | null = null;

export function getAgreementDisputeService(): AgreementDisputeService {
  if (!cached) {
    cached = new AgreementDisputeService({
      agreementService: getAgreementService(),
      amendmentService: getAmendmentService(),
      evidenceService: getEvidenceService(),
      disputes: new DrizzleAgreementDisputeRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
