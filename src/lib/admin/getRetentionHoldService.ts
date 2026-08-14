import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAdminRoleService } from "./getAdminRoleService";
import { RetentionHoldService } from "./retentionHoldService";
import { DrizzleRetentionHoldRepository } from "./drizzleRetentionHoldRepository";

let cached: RetentionHoldService | null = null;

export function getRetentionHoldService(): RetentionHoldService {
  if (!cached) {
    cached = new RetentionHoldService({
      holds: new DrizzleRetentionHoldRepository(),
      roles: getAdminRoleService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
