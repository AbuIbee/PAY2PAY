import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getAgreementService } from "./getAgreementService";
import { AgreementCancellationService } from "./agreementCancellationService";
import { DrizzleAgreementCancellationRepository } from "./drizzleAgreementCancellationRepository";

let cached: AgreementCancellationService | null = null;

export function getAgreementCancellationService(): AgreementCancellationService {
  if (!cached) {
    cached = new AgreementCancellationService({
      agreementService: getAgreementService(),
      requests: new DrizzleAgreementCancellationRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      notifications: getNotificationService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
