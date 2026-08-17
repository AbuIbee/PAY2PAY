import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { getAdminRoleService } from "./getAdminRoleService";
import { SmsDeliveryAdminService } from "./smsDeliveryAdminService";

let cached: SmsDeliveryAdminService | null = null;

/** Lazily creates (and memoizes) the production SmsDeliveryAdminService. Mirrors getEmailDeliveryAdminService.ts's pattern. */
export function getSmsDeliveryAdminService(): SmsDeliveryAdminService {
  if (!cached) {
    cached = new SmsDeliveryAdminService({
      notifications: getNotificationService(),
      roles: getAdminRoleService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
