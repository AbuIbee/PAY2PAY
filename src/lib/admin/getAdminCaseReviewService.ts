import "server-only";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { DrizzleAgreementDisputeRepository } from "@/lib/disputes/drizzleAgreementDisputeRepository";
import { DrizzlePaymentDisputeRepository } from "@/lib/disputes/drizzlePaymentDisputeRepository";
import { getAdminRoleService } from "./getAdminRoleService";
import { AdminCaseReviewService } from "./adminCaseReviewService";
import { AdminDisputeReaderAdapter } from "./adminDisputeReaderAdapter";
import { DrizzleAdminAuditReader } from "./drizzleAdminAuditReader";

let cached: AdminCaseReviewService | null = null;

export function getAdminCaseReviewService(): AdminCaseReviewService {
  if (!cached) {
    cached = new AdminCaseReviewService({
      roles: getAdminRoleService(),
      verification: getVerificationService(),
      disputes: new AdminDisputeReaderAdapter(new DrizzleAgreementDisputeRepository(), new DrizzlePaymentDisputeRepository()),
      auditReader: new DrizzleAdminAuditReader(),
    });
  }
  return cached;
}
