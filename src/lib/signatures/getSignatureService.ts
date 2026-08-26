import "server-only";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getMfaService } from "@/lib/auth/getMfaService";
import { DrizzleProfileDisplayReader } from "@/lib/documents/drizzleProfileDisplayReader";
import { getDocumentStorage } from "@/lib/documents/getDocumentStorage";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { DrizzleAgreementPdfRepository } from "./drizzleAgreementPdfRepository";
import { DrizzleSignatureEventRepository } from "./drizzleSignatureEventRepository";
import { SignatureService } from "./signatureService";

let cached: SignatureService | null = null;

/** Lazily creates (and memoizes) the production SignatureService. Mirrors getAgreementService.ts's pattern. */
export function getSignatureService(): SignatureService {
  if (!cached) {
    cached = new SignatureService({
      agreementService: getAgreementService(),
      mfa: getMfaService(),
      staffService: getStaffService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      signatureEvents: new DrizzleSignatureEventRepository(),
      agreementPdfs: new DrizzleAgreementPdfRepository(),
      profileDisplay: new DrizzleProfileDisplayReader(),
      storage: getDocumentStorage(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      notifications: getNotificationService(),
    });
  }
  return cached;
}
