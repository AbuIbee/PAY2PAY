import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { ConsoleEmailSender } from "@/lib/notify/consoleEmailSender";
import { RelationshipInvitationService } from "./relationshipInvitationService";
import { DrizzleRelationshipRepository } from "./drizzleRelationshipRepository";
import { DrizzleRelationshipParticipantRepository } from "./drizzleRelationshipParticipantRepository";
import { DrizzleRelationshipInvitationRepository } from "./drizzleRelationshipInvitationRepository";
import { DrizzleUserLookupReader } from "./drizzleUserLookupReader";

let cached: RelationshipInvitationService | null = null;

/** Lazily creates (and memoizes) the production RelationshipInvitationService. Mirrors getAgreementService.ts's pattern. */
export function getRelationshipInvitationService(): RelationshipInvitationService {
  if (!cached) {
    cached = new RelationshipInvitationService({
      relationships: new DrizzleRelationshipRepository(),
      participants: new DrizzleRelationshipParticipantRepository(),
      invitations: new DrizzleRelationshipInvitationRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      users: new DrizzleUserLookupReader(),
      notifications: getNotificationService(),
      emailSender: new ConsoleEmailSender(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
