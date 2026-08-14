import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { AdminRoleService } from "./adminRoleService";
import { DrizzleAdminRoleAssignmentRepository } from "./drizzleAdminRoleAssignmentRepository";

let cached: AdminRoleService | null = null;

/** Lazily creates (and memoizes) the production AdminRoleService. Mirrors getAgreementService.ts's pattern. */
export function getAdminRoleService(): AdminRoleService {
  if (!cached) {
    cached = new AdminRoleService({
      assignments: new DrizzleAdminRoleAssignmentRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
