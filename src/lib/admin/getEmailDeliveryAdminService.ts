import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { getAdminRoleService } from "./getAdminRoleService";
import { EmailDeliveryAdminService } from "./emailDeliveryAdminService";

let cached: EmailDeliveryAdminService | null = null;

/** Lazily creates (and memoizes) the production EmailDeliveryAdminService. Mirrors getRetentionHoldService.ts's pattern. */
export function getEmailDeliveryAdminService(): EmailDeliveryAdminService {
  if (!cached) {
    cached = new EmailDeliveryAdminService({
      notifications: getNotificationService(),
      roles: getAdminRoleService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
