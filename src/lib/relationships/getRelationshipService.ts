import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import { getDebitCardMethodService } from "@/lib/debitCard/getDebitCardMethodService";
import { getEvidenceService } from "@/lib/evidence/getEvidenceService";
import { RelationshipService } from "./relationshipService";
import { DrizzleRelationshipRepository } from "./drizzleRelationshipRepository";
import { DrizzleRelationshipParticipantRepository } from "./drizzleRelationshipParticipantRepository";
import { DrizzleRelationshipFinancialAccountRepository } from "./drizzleRelationshipFinancialAccountRepository";
import { DrizzleAgreementRelationshipLinker } from "./drizzleAgreementRelationshipLinker";
import { AchMandateFinancialAccountAdapter } from "./achMandateFinancialAccountAdapter";
import { DebitCardFinancialAccountAdapter } from "./debitCardFinancialAccountAdapter";

let cached: RelationshipService | null = null;

/** Lazily creates (and memoizes) the production RelationshipService. Mirrors getAgreementService.ts's pattern. */
export function getRelationshipService(): RelationshipService {
  if (!cached) {
    cached = new RelationshipService({
      relationships: new DrizzleRelationshipRepository(),
      participants: new DrizzleRelationshipParticipantRepository(),
      financialAccounts: new DrizzleRelationshipFinancialAccountRepository(),
      agreementService: getAgreementService(),
      agreements: new DrizzleAgreementRelationshipLinker(),
      mandates: new AchMandateFinancialAccountAdapter(getAchMandateService()),
      cards: new DebitCardFinancialAccountAdapter(getDebitCardMethodService()),
      evidence: getEvidenceService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      notifications: getNotificationService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
