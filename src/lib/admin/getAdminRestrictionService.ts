import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAdminRoleService } from "./getAdminRoleService";
import { AdminRestrictionService } from "./adminRestrictionService";
import { DrizzleAdminRestrictionRepository } from "./drizzleAdminRestrictionRepository";

let cached: AdminRestrictionService | null = null;

export function getAdminRestrictionService(): AdminRestrictionService {
  if (!cached) {
    cached = new AdminRestrictionService({
      restrictions: new DrizzleAdminRestrictionRepository(),
      roles: getAdminRoleService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
