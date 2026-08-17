import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { getEmailSender } from "@/lib/notify/getEmailSender";
import { RelationshipInvitationService } from "./relationshipInvitationService";
import { DrizzleRelationshipRepository } from "./drizzleRelationshipRepository";
import { DrizzleRelationshipParticipantRepository } from "./drizzleRelationshipParticipantRepository";
import { DrizzleRelationshipInvitationRepository } from "./drizzleRelationshipInvitationRepository";
import { DrizzleUserLookupReader } from "./drizzleUserLookupReader";

let cached: RelationshipInvitationService | null = null;

/** Lazily creates (and memoizes) the production RelationshipInvitationService. Mirrors getAgreementService.ts's pattern. */
export function getRelationshipInvitationService(): RelationshipInvitationService {
  if (!cached) {
    const { APP_URL } = getServerEnv();
    cached = new RelationshipInvitationService({
      relationships: new DrizzleRelationshipRepository(),
      participants: new DrizzleRelationshipParticipantRepository(),
      invitations: new DrizzleRelationshipInvitationRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      users: new DrizzleUserLookupReader(),
      notifications: getNotificationService(),
      emailSender: getEmailSender(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      appUrl: APP_URL,
    });
  }
  return cached;
}
