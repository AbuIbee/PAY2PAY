import "server-only";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { BasicAttachmentFileValidator } from "./attachmentFileValidator";
import { BusinessAttachmentService } from "./businessAttachmentService";
import { DrizzleBusinessCustomerRepository } from "./drizzleBusinessCustomerRepository";
import { DrizzleBusinessObligationRepository } from "./drizzleBusinessObligationRepository";
import { DrizzleOrganizationDocumentRepository } from "./drizzleOrganizationDocumentRepository";
import { getAttachmentStorage } from "./getAttachmentStorage";
import { getOrganizationPermissionService } from "./getOrganizationPermissionService";

let cached: BusinessAttachmentService | null = null;

export function getBusinessAttachmentService(): BusinessAttachmentService {
  if (!cached) {
    cached = new BusinessAttachmentService({
      documents: new DrizzleOrganizationDocumentRepository(),
      storage: getAttachmentStorage(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      permissions: getOrganizationPermissionService(),
      agreements: new DrizzleAgreementRepository(),
      customers: new DrizzleBusinessCustomerRepository(),
      obligations: new DrizzleBusinessObligationRepository(),
      fileValidator: new BasicAttachmentFileValidator(),
    });
  }
  return cached;
}
