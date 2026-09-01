import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getMfaService } from "@/lib/auth/getMfaService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getRiskEventService } from "@/lib/risk/getRiskEventService";
import { getStaffService } from "@/lib/staff/getStaffService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { RelationshipFinancialAccountService } from "./relationshipFinancialAccountService";
import { DrizzleFinancialAccountRepository } from "./drizzleFinancialAccountRepository";
import { DrizzleRelationshipFinancialAccountRepository } from "./drizzleRelationshipFinancialAccountRepository";
import { DrizzleRelationshipRepository } from "./drizzleRelationshipRepository";
import { DrizzleRelationshipParticipantRepository } from "./drizzleRelationshipParticipantRepository";
import { DrizzleRelationshipCurrentAgreementRoleReader } from "./relationshipCurrentAgreementRoleReader";
import { getRelationshipService } from "./getRelationshipService";

let cached: RelationshipFinancialAccountService | null = null;

/** Lazily creates (and memoizes) the production RelationshipFinancialAccountService. `relationshipSync` is the memoized RelationshipService itself (satisfies RelationshipStatusSyncer structurally) — one direction of dependency only, see that interface's own doc comment. */
export function getRelationshipFinancialAccountService(): RelationshipFinancialAccountService {
  if (!cached) {
    const relationships = new DrizzleRelationshipRepository();
    cached = new RelationshipFinancialAccountService({
      financialAccounts: new DrizzleFinancialAccountRepository(),
      assignments: new DrizzleRelationshipFinancialAccountRepository(),
      relationships,
      participants: new DrizzleRelationshipParticipantRepository(),
      relationshipSync: getRelationshipService(),
      agreementRoles: new DrizzleRelationshipCurrentAgreementRoleReader(relationships, getAgreementService()),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      notifications: getNotificationService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      mfa: getMfaService(),
      riskEvents: getRiskEventService(),
    });
  }
  return cached;
}
