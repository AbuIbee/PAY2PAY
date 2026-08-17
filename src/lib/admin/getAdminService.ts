import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleSessionRepository } from "@/lib/auth/drizzleSessionRepository";
import { DrizzleUserAccountRepository } from "@/lib/auth/drizzleUserAccountRepository";
import { getMfaService } from "@/lib/auth/getMfaService";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { AdminService } from "./adminService";
import { DrizzleAdminBusinessDirectoryReader } from "./drizzleAdminBusinessDirectoryReader";
import { DrizzleAdminImpersonationSessionRepository } from "./drizzleAdminImpersonationSessionRepository";
import { DrizzleAdminOverviewReader } from "./drizzleAdminOverviewReader";
import { DrizzleAdminUserDirectoryReader } from "./drizzleAdminUserDirectoryReader";
import { RealEnvironmentStatusReader } from "./environmentStatus";

let cached: AdminService | null = null;

/** Lazily creates (and memoizes) the production AdminService. Mirrors getAgreementService.ts's pattern. */
export function getAdminService(): AdminService {
  if (!cached) {
    cached = new AdminService({
      users: new DrizzleUserAccountRepository(),
      sessions: new DrizzleSessionRepository(),
      mfa: getMfaService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      overview: new DrizzleAdminOverviewReader(),
      directory: new DrizzleAdminUserDirectoryReader(),
      impersonationSessions: new DrizzleAdminImpersonationSessionRepository(),
      environmentStatus: new RealEnvironmentStatusReader(),
      businesses: new DrizzleBusinessProfileRepository(),
      businessDirectory: new DrizzleAdminBusinessDirectoryReader(),
    });
  }
  return cached;
}
