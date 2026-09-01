import "server-only";
import type { AgreementService } from "@/lib/agreements/agreementService";
import type { PartyRef } from "./relationshipInvitationService";
import type { RelationshipCurrentAgreementRoleReader } from "./relationshipFinancialAccountService";
import type { RelationshipRepository } from "./relationshipService";

/**
 * Decision 1 (reversed-role safety): real implementation of `RelationshipCurrentAgreementRoleReader`
 * (see that interface's own doc comment in relationshipFinancialAccountService.ts). Resolves the
 * relationship's `current_agreement_id` — kept post-Decision-2 as "the most recently linked
 * agreement", never as an exclusivity lock — and reads that agreement's real creditor/debtor profile
 * refs directly from `AgreementService`, never from the relationship-level `relationship_participant.
 * role` column, which cannot represent a role that has been reversed by a later agreement on the same
 * connection.
 */
export class DrizzleRelationshipCurrentAgreementRoleReader implements RelationshipCurrentAgreementRoleReader {
  constructor(
    private readonly relationships: RelationshipRepository,
    private readonly agreementService: AgreementService,
  ) {}

  async getCurrentAgreementRoles(relationshipId: string): Promise<{ creditor: PartyRef; debtor: PartyRef } | null> {
    const relationship = await this.relationships.findById(relationshipId);
    if (!relationship?.currentAgreementId) return null;
    try {
      // Best-effort: a stale or unreadable current_agreement_id must never break financial-account
      // validation — callers fall back to the pre-agreement (participant-role) path when this
      // returns null, which remains correct for that case.
      const { agreement } = await this.agreementService.getAgreement(relationship.currentAgreementId, relationship.initiatorUserId);
      return {
        creditor: { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId },
        debtor: { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId },
      };
    } catch {
      return null;
    }
  }
}
