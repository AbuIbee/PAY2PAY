import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { RelationshipFinancialAccountService } from "./relationshipFinancialAccountService";
import { DrizzleFinancialAccountRepository } from "./drizzleFinancialAccountRepository";
import { DrizzleRelationshipFinancialAccountRepository } from "./drizzleRelationshipFinancialAccountRepository";
import { DrizzleRelationshipRepository } from "./drizzleRelationshipRepository";
import { DrizzleRelationshipParticipantRepository } from "./drizzleRelationshipParticipantRepository";
import { getRelationshipService } from "./getRelationshipService";

let cached: RelationshipFinancialAccountService | null = null;

/** Lazily creates (and memoizes) the production RelationshipFinancialAccountService. `relationshipSync` is the memoized RelationshipService itself (satisfies RelationshipStatusSyncer structurally) — one direction of dependency only, see that interface's own doc comment. */
export function getRelationshipFinancialAccountService(): RelationshipFinancialAccountService {
  if (!cached) {
    cached = new RelationshipFinancialAccountService({
      financialAccounts: new DrizzleFinancialAccountRepository(),
      assignments: new DrizzleRelationshipFinancialAccountRepository(),
      relationships: new DrizzleRelationshipRepository(),
      participants: new DrizzleRelationshipParticipantRepository(),
      relationshipSync: getRelationshipService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      notifications: getNotificationService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
