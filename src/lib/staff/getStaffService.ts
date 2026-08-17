import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleSessionRepository } from "@/lib/auth/drizzleSessionRepository";
import { getMfaService } from "@/lib/auth/getMfaService";
import { getEmailSender } from "@/lib/notify/getEmailSender";
import { DrizzleBusinessStaffMemberRepository } from "./drizzleBusinessStaffMemberRepository";
import { DrizzleCustomRoleRepository } from "./drizzleCustomRoleRepository";
import { DrizzleStaffInvitationRepository } from "./drizzleStaffInvitationRepository";
import { DrizzleUserEmailReader } from "./drizzleUserEmailReader";
import { StaffService } from "./staffService";

let cached: StaffService | null = null;

/** Lazily creates (and memoizes) the production StaffService. Mirrors getAuthService.ts's pattern. */
export function getStaffService(): StaffService {
  if (cached) return cached;
  const { APP_URL } = getServerEnv();
  cached = new StaffService(
    new DrizzleBusinessStaffMemberRepository(),
    new DrizzleCustomRoleRepository(),
    new DrizzleStaffInvitationRepository(),
    new DrizzleSessionRepository(),
    getMfaService(),
    new DrizzleUserEmailReader(),
    new AuditService(new DrizzleAuditEventRepository()),
    getEmailSender(),
    { appUrl: APP_URL },
  );
  return cached;
}
