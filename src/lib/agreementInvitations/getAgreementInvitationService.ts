import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { ConsoleEmailSender } from "@/lib/notify/consoleEmailSender";
import { ConsoleSmsSender } from "@/lib/notify/consoleSmsSender";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzleUserLookupReader } from "@/lib/relationships/drizzleUserLookupReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { DrizzleUserEmailReader } from "@/lib/staff/drizzleUserEmailReader";
import { AgreementInvitationService } from "./agreementInvitationService";
import { DrizzleAgreementInvitationRepository } from "./drizzleAgreementInvitationRepository";
import { DrizzleProfileDisplayReader } from "./drizzleProfileDisplayReader";

let cached: AgreementInvitationService | null = null;

/** Lazily creates (and memoizes) the production AgreementInvitationService. Mirrors getRelationshipInvitationService.ts's pattern. */
export function getAgreementInvitationService(): AgreementInvitationService {
  if (!cached) {
    const { APP_URL } = getServerEnv();
    cached = new AgreementInvitationService({
      invitations: new DrizzleAgreementInvitationRepository(),
      agreements: getAgreementService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      profileDisplay: new DrizzleProfileDisplayReader(),
      staffService: getStaffService(),
      users: new DrizzleUserLookupReader(),
      userEmails: new DrizzleUserEmailReader(),
      notifications: getNotificationService(),
      emailSender: new ConsoleEmailSender(),
      smsSender: new ConsoleSmsSender(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      appUrl: APP_URL,
    });
  }
  return cached;
}
