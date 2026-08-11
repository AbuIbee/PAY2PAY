import "server-only";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { B2BWorkflowService } from "./b2bWorkflowService";
import { DrizzleAgreementReferenceRepository } from "./drizzleAgreementReferenceRepository";

let cached: B2BWorkflowService | null = null;

/** Lazily creates (and memoizes) the production B2BWorkflowService. Mirrors getSignatureService.ts's pattern. */
export function getB2BWorkflowService(): B2BWorkflowService {
  if (!cached) {
    cached = new B2BWorkflowService({
      agreementService: getAgreementService(),
      verification: getVerificationService(),
      references: new DrizzleAgreementReferenceRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
