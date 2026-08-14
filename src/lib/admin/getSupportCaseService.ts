import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAdminRoleService } from "./getAdminRoleService";
import { SupportCaseService } from "./supportCaseService";
import { DrizzleSupportCaseRepository } from "./drizzleSupportCaseRepository";

let cached: SupportCaseService | null = null;

export function getSupportCaseService(): SupportCaseService {
  if (!cached) {
    cached = new SupportCaseService({
      cases: new DrizzleSupportCaseRepository(),
      roles: getAdminRoleService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
