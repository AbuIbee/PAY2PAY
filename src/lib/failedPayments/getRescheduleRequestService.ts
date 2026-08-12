import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzleAgreementPartiesReader } from "./drizzleAgreementPartiesReader";
import { DrizzleInstallmentStatusRepository } from "./drizzleInstallmentStatusRepository";
import { DrizzleRescheduleRequestRepository } from "./drizzleRescheduleRequestRepository";
import { RescheduleRequestService } from "./rescheduleRequestService";

let cached: RescheduleRequestService | null = null;

export function getRescheduleRequestService(): RescheduleRequestService {
  if (!cached) {
    cached = new RescheduleRequestService({
      requests: new DrizzleRescheduleRequestRepository(),
      installments: new DrizzleInstallmentStatusRepository(),
      parties: new DrizzleAgreementPartiesReader(),
      profileOwners: new DrizzleProfileOwnerReader(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
