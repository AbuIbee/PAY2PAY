import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { getLedgerAdminService } from "@/lib/ledger/getLedgerAdminService";
import { getAdminRoleService } from "./getAdminRoleService";
import { getAdminRestrictionService } from "./getAdminRestrictionService";
import { AppealService } from "./appealService";
import { DrizzleAppealRepository } from "./drizzleAppealRepository";

let cached: AppealService | null = null;

export function getAppealService(): AppealService {
  if (!cached) {
    cached = new AppealService({
      appeals: new DrizzleAppealRepository(),
      roles: getAdminRoleService(),
      restrictions: getAdminRestrictionService(),
      ledger: getLedgerAdminService(),
      notifications: getNotificationService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
