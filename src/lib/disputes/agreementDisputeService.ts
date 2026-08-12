import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { isAdminRole } from "@/lib/admin/capabilities";
import type { PlatformRole } from "@/lib/auth/authService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { AgreementService, DraftTermsInput, PartyRole } from "@/lib/agreements/agreementService";
import type { AmendmentChangeType, AmendmentRecord, AmendmentService } from "@/lib/amendments/amendmentService";
import type { EvidenceRecord, EvidenceService } from "@/lib/evidence/evidenceService";

export type AgreementDisputeStatus = "opened" | "under_review" | "resolved_no_change" | "resolved_with_amendment" | "restricted" | "closed";
export type AgreementDisputeCategory = "debt_does_not_exist" | "incorrect_amount" | "evidence_challenged" | "administration_challenged" | "other";

export interface AgreementDisputeRecord {
  id: string;
  agreementId: string;
  status: AgreementDisputeStatus;
  category: AgreementDisputeCategory;
  explanation: string;
  raisedByRole: PartyRole;
  raisedByProfileKind: ProfileKind;
  raisedByProfileId: string;
  raisedByUserId: string;
  response: string | null;
  respondedByUserId: string | null;
  respondedAt: Date | null;
  resolutionNotes: string | null;
  resolvedAt: Date | null;
  resultingAmendmentId: string | null;
  restrictedReason: string | null;
  restrictedByUserId: string | null;
  restrictedAt: Date | null;
  restrictionLiftedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleAgreementDisputeRepository. */
export interface AgreementDisputeRepository {
  insert(input: {
    agreementId: string;
    category: AgreementDisputeCategory;
    explanation: string;
    raisedByRole: PartyRole;
    raisedByProfileKind: ProfileKind;
    raisedByProfileId: string;
    raisedByUserId: string;
  }): Promise<AgreementDisputeRecord>;
  findById(id: string): Promise<AgreementDisputeRecord | null>;
  listForAgreement(agreementId: string): Promise<AgreementDisputeRecord[]>;
  recordResponse(id: string, input: { response: string; respondedByUserId: string }): Promise<AgreementDisputeRecord>;
  recordResolvedNoChange(id: string, resolutionNotes: string | null): Promise<AgreementDisputeRecord>;
  recordResolvedWithAmendment(id: string, resultingAmendmentId: string): Promise<AgreementDisputeRecord>;
  recordRestricted(id: string, input: { reason: string; restrictedByUserId: string }): Promise<AgreementDisputeRecord>;
  recordRestrictionLifted(id: string, target: "under_review" | "closed"): Promise<AgreementDisputeRecord>;
  recordClosed(id: string, resolutionNotes: string | null): Promise<AgreementDisputeRecord>;
}

export interface AgreementDisputeServiceDeps {
  agreementService: AgreementService;
  amendmentService: AmendmentService;
  evidenceService: EvidenceService;
  disputes: AgreementDisputeRepository;
  audit: AuditService;
}

/**
 * Sprint 16 (docs/sprints/SPRINT_16_Disputes.md): implements master spec §13's agreement-level
 * dispute and `docs/STATE_MACHINES.md` §7's lifecycle (see agreementDispute.ts's doc comment for the
 * one deliberate state-collapsing decision). "The platform must not adjudicate legal liability" (this
 * sprint's own instruction, verbatim) is enforced by construction: `resolveNoChange`'s
 * `resolutionNotes` and `restrictDispute`'s `reason` are free-text records of what happened, never a
 * structured "party X was at fault" field anywhere on this table — matching
 * `docs/STATE_MACHINES.md` §7's own "never sets a terminal state that declares a party legally
 * correct" (FR-DISP-004).
 *
 * Evidence is never duplicated onto this table — every evidence-carrying action (`openDispute`,
 * `respondToDispute`) accepts evidence document ids and flags them via
 * `EvidenceService.setDisputeFlag` (Sprint 7's own field, reserved for exactly this), so "this
 * dispute's evidence" is always just "this agreement's evidence documents currently flagged," never
 * a second store that could drift from the first.
 *
 * `resolveWithAmendment` hands off to `AmendmentService` (Sprint 14) rather than re-implementing any
 * negotiation/signature machinery — the resulting amendment's own lifecycle (accept/reject/counter,
 * dual signature, new version) is entirely `AmendmentService`'s concern; this class only records
 * which amendment resulted and later checks (`syncAmendmentProgress`) whether it has reached
 * `Applied`, at which point the dispute closes.
 */
export class AgreementDisputeService {
  constructor(private readonly deps: AgreementDisputeServiceDeps) {}

  async openDispute(input: {
    agreementId: string;
    category: AgreementDisputeCategory;
    explanation: string;
    evidenceIds?: string[];
    actingUserId: string;
  }): Promise<AgreementDisputeRecord> {
    const role = await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);
    const detail = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);
    if (!input.explanation.trim()) {
      throw new ValidationError("A written explanation is required to open a dispute.");
    }

    const raiser = role === "creditor" ? detail.agreement.creditorProfileKind : detail.agreement.debtorProfileKind;
    const raiserId = role === "creditor" ? detail.agreement.creditorProfileId : detail.agreement.debtorProfileId;

    await this.flagEvidence(input.evidenceIds, input.actingUserId);

    const dispute = await this.deps.disputes.insert({
      agreementId: input.agreementId,
      category: input.category,
      explanation: input.explanation,
      raisedByRole: role,
      raisedByProfileKind: raiser,
      raisedByProfileId: raiserId,
      raisedByUserId: input.actingUserId,
    });
    await this.recordAudit(dispute, input.actingUserId, "agreement_dispute_opened", { category: input.category });
    return dispute;
  }

  async respondToDispute(input: {
    disputeId: string;
    response: string;
    evidenceIds?: string[];
    actingUserId: string;
  }): Promise<AgreementDisputeRecord> {
    const dispute = await this.requireDispute(input.disputeId);
    if (dispute.status !== "opened") {
      throw new ValidationError(`This action requires status "opened", but the dispute is "${dispute.status}".`);
    }
    const role = await this.deps.agreementService.resolvePartyRole(dispute.agreementId, input.actingUserId);
    if (role === dispute.raisedByRole) {
      throw new ForbiddenError("You raised this dispute — only the other party may respond to it.");
    }
    if (!input.response.trim()) {
      throw new ValidationError("A response is required.");
    }

    await this.flagEvidence(input.evidenceIds, input.actingUserId);

    const updated = await this.deps.disputes.recordResponse(dispute.id, {
      response: input.response,
      respondedByUserId: input.actingUserId,
    });
    await this.recordAudit(updated, input.actingUserId, "agreement_dispute_responded", null);
    return updated;
  }

  async resolveNoChange(input: { disputeId: string; actingUserId: string; resolutionNotes?: string }): Promise<AgreementDisputeRecord> {
    const dispute = await this.requireOpenOrUnderReview(input.disputeId, input.actingUserId);
    const updated = await this.deps.disputes.recordResolvedNoChange(dispute.id, input.resolutionNotes ?? null);
    await this.recordAudit(updated, input.actingUserId, "agreement_dispute_resolved_no_change", { resolutionNotes: input.resolutionNotes ?? null });
    return updated;
  }

  /** Closes a `resolved_no_change` dispute. A `resolved_with_amendment` dispute closes via `syncAmendmentProgress` instead, once its amendment applies. */
  async closeDispute(input: { disputeId: string; actingUserId: string }): Promise<AgreementDisputeRecord> {
    const dispute = await this.requireDispute(input.disputeId);
    await this.deps.agreementService.resolvePartyRole(dispute.agreementId, input.actingUserId);
    if (dispute.status !== "resolved_no_change") {
      throw new ValidationError(`This action requires status "resolved_no_change", but the dispute is "${dispute.status}".`);
    }
    const updated = await this.deps.disputes.recordClosed(dispute.id, dispute.resolutionNotes);
    await this.recordAudit(updated, input.actingUserId, "agreement_dispute_closed", null);
    return updated;
  }

  async resolveWithAmendment(input: {
    disputeId: string;
    actingUserId: string;
    changeType: AmendmentChangeType;
    proposedTerms: DraftTermsInput;
    requestedRelief?: string;
    proposedEffectiveDate?: string;
  }): Promise<AgreementDisputeRecord> {
    const dispute = await this.requireOpenOrUnderReview(input.disputeId, input.actingUserId);

    const amendment: AmendmentRecord = await this.deps.amendmentService.proposeAmendment({
      agreementId: dispute.agreementId,
      changeType: input.changeType,
      reason: `Resolution of agreement dispute ${dispute.id}`,
      requestedRelief: input.requestedRelief,
      proposedEffectiveDate: input.proposedEffectiveDate,
      proposedTerms: input.proposedTerms,
      actingUserId: input.actingUserId,
    });

    const updated = await this.deps.disputes.recordResolvedWithAmendment(dispute.id, amendment.id);
    await this.recordAudit(updated, input.actingUserId, "agreement_dispute_resolved_with_amendment", { resultingAmendmentId: amendment.id });
    return updated;
  }

  /** Read-time sync — checks whether a linked amendment has reached Applied, and closes the dispute if so. Callers (routes/UI) invoke this after any amendment-lifecycle action to keep the dispute's own status current, rather than this class depending on AmendmentService to call back into it. */
  async syncAmendmentProgress(input: { disputeId: string; actingUserId: string }): Promise<AgreementDisputeRecord> {
    const dispute = await this.requireDispute(input.disputeId);
    await this.deps.agreementService.resolvePartyRole(dispute.agreementId, input.actingUserId);
    if (dispute.status !== "resolved_with_amendment" || !dispute.resultingAmendmentId) {
      return dispute;
    }
    const amendment = await this.deps.amendmentService.getAmendment(dispute.resultingAmendmentId, input.actingUserId);
    if (amendment.status !== "applied") {
      return dispute;
    }
    const closed = await this.deps.disputes.recordClosed(dispute.id, dispute.resolutionNotes);
    await this.recordAudit(closed, input.actingUserId, "agreement_dispute_closed", { resultingAmendmentId: amendment.id });
    return closed;
  }

  /** Processor/administrator-imposed restriction (master spec §13/§17) — Platform Admin or Owner only, never an agreement party. */
  async restrictDispute(input: { disputeId: string; actingUserId: string; actingRole: PlatformRole; reason: string }): Promise<AgreementDisputeRecord> {
    this.requireAdmin(input.actingRole);
    const dispute = await this.requireDispute(input.disputeId);
    if (dispute.status !== "under_review") {
      throw new ValidationError(`This action requires status "under_review", but the dispute is "${dispute.status}".`);
    }
    if (!input.reason.trim()) {
      throw new ValidationError("A reason is required to impose a restriction.");
    }
    const updated = await this.deps.disputes.recordRestricted(dispute.id, { reason: input.reason, restrictedByUserId: input.actingUserId });
    await this.recordAudit(updated, input.actingUserId, "agreement_dispute_restricted", { reason: input.reason });
    return updated;
  }

  /** "Restriction lifted, review continues" or "restriction resolves the dispute" (`docs/STATE_MACHINES.md` §7) — the admin chooses which. */
  async liftRestriction(input: {
    disputeId: string;
    actingUserId: string;
    actingRole: PlatformRole;
    target: "under_review" | "closed";
    resolutionNotes?: string;
  }): Promise<AgreementDisputeRecord> {
    this.requireAdmin(input.actingRole);
    const dispute = await this.requireDispute(input.disputeId);
    if (dispute.status !== "restricted") {
      throw new ValidationError(`This action requires status "restricted", but the dispute is "${dispute.status}".`);
    }
    const updated = await this.deps.disputes.recordRestrictionLifted(dispute.id, input.target);
    if (input.target === "closed" && input.resolutionNotes) {
      const withNotes = await this.deps.disputes.recordClosed(dispute.id, input.resolutionNotes);
      await this.recordAudit(withNotes, input.actingUserId, "agreement_dispute_restriction_lifted", { target: input.target });
      return withNotes;
    }
    await this.recordAudit(updated, input.actingUserId, "agreement_dispute_restriction_lifted", { target: input.target });
    return updated;
  }

  async getDispute(disputeId: string, actingUserId: string): Promise<AgreementDisputeRecord> {
    const dispute = await this.requireDispute(disputeId);
    await this.deps.agreementService.resolvePartyRole(dispute.agreementId, actingUserId);
    return dispute;
  }

  async listDisputes(agreementId: string, actingUserId: string): Promise<AgreementDisputeRecord[]> {
    await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    return this.deps.disputes.listForAgreement(agreementId);
  }

  /** "Support evidence-package export" (this sprint's own instruction) — a structured bundle of the dispute record plus its currently-flagged evidence; the audit trail itself is not duplicated here, since every transition above already writes through AuditService's own append-only, separately queryable log. */
  async exportEvidencePackage(disputeId: string, actingUserId: string): Promise<{ dispute: AgreementDisputeRecord; evidence: EvidenceRecord[] }> {
    const dispute = await this.requireDispute(disputeId);
    await this.deps.agreementService.resolvePartyRole(dispute.agreementId, actingUserId);
    const evidence = (await this.deps.evidenceService.listEvidence(dispute.agreementId, actingUserId)).filter((e) => e.disputeFlag);
    return { dispute, evidence };
  }

  private async flagEvidence(evidenceIds: string[] | undefined, actingUserId: string): Promise<void> {
    if (!evidenceIds || evidenceIds.length === 0) return;
    for (const evidenceId of evidenceIds) {
      await this.deps.evidenceService.setDisputeFlag(evidenceId, actingUserId, true, null, null);
    }
  }

  private async requireOpenOrUnderReview(disputeId: string, actingUserId: string): Promise<AgreementDisputeRecord> {
    const dispute = await this.requireDispute(disputeId);
    await this.deps.agreementService.resolvePartyRole(dispute.agreementId, actingUserId);
    if (dispute.status !== "opened" && dispute.status !== "under_review") {
      throw new ValidationError(`This action requires status "opened" or "under_review", but the dispute is "${dispute.status}".`);
    }
    return dispute;
  }

  private async requireDispute(id: string): Promise<AgreementDisputeRecord> {
    const dispute = await this.deps.disputes.findById(id);
    if (!dispute) throw new ValidationError("Agreement dispute not found.");
    return dispute;
  }

  private requireAdmin(role: PlatformRole): void {
    if (!isAdminRole(role)) {
      throw new ForbiddenError("Administrative access is required.");
    }
  }

  private async recordAudit(dispute: AgreementDisputeRecord, actorUserId: string, action: string, newValue: unknown): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: dispute.raisedByProfileKind,
      profileId: dispute.raisedByProfileId,
      agreementId: dispute.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "agreement_dispute",
      targetResourceId: dispute.id,
    });
  }
}
