import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getEmailSender } from "@/lib/notify/getEmailSender";
import { PersonalProfileService } from "./personalProfileService";
import { DrizzlePersonalProfileRepository } from "./drizzlePersonalProfileRepository";
import { DrizzlePreferredEmailVerificationRepository } from "./drizzlePreferredEmailVerificationRepository";
import { DrizzleUserAuthEmailReader } from "./drizzleUserAuthEmailReader";

let cached: PersonalProfileService | null = null;

/** Lazily creates (and memoizes) the production PersonalProfileService. Mirrors getBusinessProfileService.ts's pattern. */
export function getPersonalProfileService(): PersonalProfileService {
  if (!cached) {
    const { APP_URL } = getServerEnv();
    cached = new PersonalProfileService({
      profiles: new DrizzlePersonalProfileRepository(),
      verificationTokens: new DrizzlePreferredEmailVerificationRepository(),
      authEmails: new DrizzleUserAuthEmailReader(),
      emailSender: getEmailSender(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      appUrl: APP_URL,
    });
  }
  return cached;
}
