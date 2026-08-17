import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import {
  buildTerms,
  type AgreementRecord,
  type AgreementService,
  type AgreementTerms,
  type AgreementVersionRepository,
  type DraftTermsInput,
  type FeeAllocation,
  type PartyRole,
} from "@/lib/agreements/agreementService";
import { computeVersionHash } from "@/lib/agreements/documentHash";
import { computeSchedule, type PaymentFrequency } from "@/lib/agreements/schedule";

export type AmendmentStatus = "proposed" | "awaiting_signatures" | "signed" | "applied" | "rejected" | "withdrawn";
export type AmendmentChangeType = "new_date" | "temporary_pause" | "reduced_installment" | "revised_schedule" | "general";

export interface AmendmentRecord {
  id: string;
  agreementId: string;
  changeType: AmendmentChangeType;
  status: AmendmentStatus;
  proposingPartyRole: PartyRole;
  proposedByProfileKind: ProfileKind;
  proposedByProfileId: string;
  reason: string;
  requestedRelief: string | null;
  proposedEffectiveDate: string | null;
  frequency: PaymentFrequency;
  feeAllocation: FeeAllocation;
  terms: AgreementTerms;
  creditorSignedAt: Date | null;
  debtorSignedAt: Date | null;
  signedAt: Date | null;
  resultingVersionId: string | null;
  rejectedReason: string | null;
  rejectedAt: Date | null;
  withdrawnReason: string | null;
  withdrawnAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleAmendmentRepository. */
export interface AmendmentRepository {
  insert(input: {
    agreementId: string;
    changeType: AmendmentChangeType;
    proposingPartyRole: PartyRole;
    proposedByProfileKind: ProfileKind;
    proposedByProfileId: string;
    reason: string;
    requestedRelief: string | null;
    proposedEffectiveDate: string | null;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
  }): Promise<AmendmentRecord>;
  findById(id: string): Promise<AmendmentRecord | null>;
  listForAgreement(agreementId: string): Promise<AmendmentRecord[]>;
  /** Counter — mutates the same row's proposed content in place; see AmendmentService.decideAmendment's doc comment for why this mirrors AgreementService.creditorDecide rather than creating a new row. */
  updateProposedTerms(
    id: string,
    input: {
      proposingPartyRole: PartyRole;
      proposedByProfileKind: ProfileKind;
      proposedByProfileId: string;
      reason: string;
      requestedRelief: string | null;
      proposedEffectiveDate: string | null;
      frequency: PaymentFrequency;
      feeAllocation: FeeAllocation;
      terms: AgreementTerms;
    },
  ): Promise<AmendmentRecord>;
  updateStatus(id: string, status: AmendmentStatus): Promise<AmendmentRecord>;
  recordRejection(id: string, reason: string | null): Promise<AmendmentRecord>;
  recordWithdrawal(id: string, reason: string | null): Promise<AmendmentRecord>;
  recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<AmendmentRecord>;
  recordApplied(id: string, resultingVersionId: string): Promise<AmendmentRecord>;
}

/**
 * PRSprint 11 (docs/prsprints/PRSPRINT_11_AGREEMENT_VERSIONING_AMENDMENTS_MUTUAL_APPROVAL.md): the
 * single atomic write path for applying a fully-signed amendment. Before this PRSprint,
 * `applyAmendment` made 7 sequential, independent calls across 4 separate repositories
 * (`versions.insert`, `scheduleItems.replaceForVersion`, `versions.recordSignature` x2,
 * `versions.lock`, `agreements.setCurrentVersionId`, `agreements.updateStatus`,
 * `amendments.recordApplied`) with no transaction spanning them — a crash or error partway through
 * could leave a new `agreement_version` row created but never linked as current, or the agreement's
 * current version advanced while the amendment itself still shows "signed" instead of "applied" —
 * exactly the "an amendment can partially apply" condition this PRSprint's own Hard Stop rule names.
 * Real implementation: DrizzleAmendmentApplicationRepository, which wraps every one of these writes
 * in a single `db.transaction`, mirroring `DrizzleLedgerJournalEntryRepository.insert`'s identical
 * "multi-table write that must succeed or fail as one unit" pattern (PRSprint 03's own audited
 * precedent) — the one place in this codebase that already got this right.
 */
export interface AmendmentApplicationRepository {
  applyAtomically(input: {
    agreementId: string;
    amendmentId: string;
    versionNumber: number;
    parentVersionId: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
    scheduleItems: { sequenceNumber: number; dueDate: string; amountMinorUnits: number }[];
    creditorSignedAt: Date | null;
    debtorSignedAt: Date | null;
    documentHash: string;
    signedAt: Date;
    pauseAgreement: boolean;
  }): Promise<{ agreementVersionId: string; amendment: AmendmentRecord }>;
}

export interface AmendmentServiceDeps {
  agreementService: AgreementService;
  amendments: AmendmentRepository;
  /** Read-only here — `findById` alone, to compute the next version number. All writes go through `application` (see AmendmentApplicationRepository's own doc comment). */
  versions: AgreementVersionRepository;
  application: AmendmentApplicationRepository;
  audit: AuditService;
  /** PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): resolves an amendment counterparty's account-owner user id — mirrors AgreementService's own identical dependency. */
  profileOwners: ProfileOwnerReader;
  /** Optional — mirrors AgreementServiceDeps's own identical `notifications?` precedent; every notification call here is wrapped in its own try/catch, so a notification-layer failure can never fail the amendment transition it's reporting on. */
  notifications?: NotificationService;
}

export interface ProposeAmendmentInput {
  agreementId: string;
  changeType: AmendmentChangeType;
  reason: string;
  requestedRelief?: string;
  proposedEffectiveDate?: string;
  proposedTerms: DraftTermsInput;
  actingUserId: string;
}

/**
 * Sprint 14 (docs/sprints/SPRINT_14_Amendments_Hardship.md): implements `docs/STATE_MACHINES.md` §3's
 * Amendment lifecycle. "Until both parties approve/sign: the existing agreement remains controlling"
 * (master spec §9) is enforced structurally, not just by convention: nothing in this class ever
 * writes to `agreement.current_version_id`, `agreement.status`, or any `agreement_version` row until
 * `signAmendment` observes both signatures and calls `applyAmendment` — every earlier step
 * (propose/accept/reject/counter) only ever touches this sprint's own `amendment` row. "No interest,
 * no penalty growth" (master spec §9, FR-HARD-004) is enforced by construction, not a runtime check:
 * `AgreementTerms` (src/lib/agreements/agreementService.ts) has no interest-rate or penalty field
 * anywhere in this codebase for an amendment to populate even if it tried.
 *
 * Authorization is never re-implemented here — every check delegates to
 * `AgreementService.resolvePartyRole`/`getAgreement`/`requireCreditorCapability`. A business-staff
 * creditor deciding a proposal additionally requires the `approve_agreement` capability
 * (`requireCreditorCapability`, added during this sprint's own Product Owner review pass — see
 * `docs/SPRINT_CONTROL.md`), mirroring `AgreementService.creditorDecide`'s identical gate for the
 * original agreement's accept/reject/counter decision exactly. Propose/sign/withdraw intentionally
 * do not carry a capability gate, matching Sprint 5's own asymmetric precedent (debtor
 * acknowledgment and signing have no dedicated capability in Sprint 4's fixed 13-capability list —
 * "any active staff member" is correct for those, not a gap).
 */
export class AmendmentService {
  constructor(private readonly deps: AmendmentServiceDeps) {}

  async proposeAmendment(input: ProposeAmendmentInput): Promise<AmendmentRecord> {
    const detail = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);
    const role = await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);
    const proposer = role === "creditor" ? detail.agreement.creditorProfileKind : detail.agreement.debtorProfileKind;
    const proposerId = role === "creditor" ? detail.agreement.creditorProfileId : detail.agreement.debtorProfileId;

    if (!input.reason.trim()) {
      throw new ValidationError("A reason is required to propose an amendment.");
    }
    const { terms } = buildTerms(input.proposedTerms);

    const amendment = await this.deps.amendments.insert({
      agreementId: input.agreementId,
      changeType: input.changeType,
      proposingPartyRole: role,
      proposedByProfileKind: proposer,
      proposedByProfileId: proposerId,
      reason: input.reason,
      requestedRelief: input.requestedRelief ?? null,
      proposedEffectiveDate: input.proposedEffectiveDate ?? null,
      frequency: input.proposedTerms.frequency,
      feeAllocation: input.proposedTerms.feeAllocation,
      terms,
    });

    const auditId = await this.recordAudit(amendment, input.actingUserId, "amendment_proposed", { changeType: input.changeType });
    const counterpartyRole: PartyRole = role === "creditor" ? "debtor" : "creditor";
    await this.notifyParty(detail.agreement, counterpartyRole, "amendment", { changeType: input.changeType }, auditId);
    return amendment;
  }

  async decideAmendment(input: {
    amendmentId: string;
    actingUserId: string;
    decision: "accept" | "reject" | "counter";
    reason?: string;
    counterTerms?: DraftTermsInput;
    counterReason?: string;
    counterRequestedRelief?: string;
    counterProposedEffectiveDate?: string;
  }): Promise<AmendmentRecord> {
    const amendment = await this.requireAmendment(input.amendmentId);
    if (amendment.status !== "proposed") {
      throw new ValidationError(`This action requires status "proposed", but the amendment is "${amendment.status}".`);
    }

    const role = await this.deps.agreementService.resolvePartyRole(amendment.agreementId, input.actingUserId);
    if (role === amendment.proposingPartyRole) {
      // "unauthorized change blocked": the proposer cannot decide their own proposal — only the
      // counterparty can accept/reject/counter it.
      throw new ForbiddenError("You proposed this amendment — only the other party may accept, reject, or counter it.");
    }
    if (role === "creditor") {
      // Mirrors AgreementService.creditorDecide's own approve_agreement capability gate exactly —
      // a business-staff creditor deciding an amendment needs the same capability the original
      // agreement's accept/reject/counter decision requires, not just "any active staff member."
      // No-op for a personal creditor or the business's own owner (see requireCreditorCapability's
      // doc comment).
      await this.deps.agreementService.requireCreditorCapability(amendment.agreementId, input.actingUserId, "approve_agreement");
    }

    if (input.decision === "accept") {
      const updated = await this.deps.amendments.updateStatus(amendment.id, "awaiting_signatures");
      const auditId = await this.recordAudit(updated, input.actingUserId, "amendment_accepted", null);
      const detail = await this.deps.agreementService.getAgreement(amendment.agreementId, input.actingUserId);
      await this.notifyParty(detail.agreement, amendment.proposingPartyRole, "amendment_decided", { decision: "accepted" }, auditId);
      return updated;
    }

    if (input.decision === "reject") {
      const updated = await this.deps.amendments.recordRejection(amendment.id, input.reason ?? null);
      const auditId = await this.recordAudit(updated, input.actingUserId, "amendment_rejected", { reason: input.reason ?? null });
      const detail = await this.deps.agreementService.getAgreement(amendment.agreementId, input.actingUserId);
      await this.notifyParty(detail.agreement, amendment.proposingPartyRole, "amendment_decided", { decision: "rejected" }, auditId);
      return updated;
    }

    // counter — still unsigned (status "proposed"), so mutating this row's own proposed content in
    // place is not an FR-AGR-006 violation, mirroring AgreementService.creditorDecide's identical
    // reasoning for the original agreement's pre-signature counter.
    if (!input.counterTerms) {
      throw new ValidationError("counterTerms is required for a counterproposal.");
    }
    const detail = await this.deps.agreementService.getAgreement(amendment.agreementId, input.actingUserId);
    const counterer = role === "creditor" ? detail.agreement.creditorProfileKind : detail.agreement.debtorProfileKind;
    const countererId = role === "creditor" ? detail.agreement.creditorProfileId : detail.agreement.debtorProfileId;
    const { terms } = buildTerms(input.counterTerms);

    const updated = await this.deps.amendments.updateProposedTerms(amendment.id, {
      proposingPartyRole: role,
      proposedByProfileKind: counterer,
      proposedByProfileId: countererId,
      reason: input.counterReason ?? amendment.reason,
      requestedRelief: input.counterRequestedRelief ?? amendment.requestedRelief,
      proposedEffectiveDate: input.counterProposedEffectiveDate ?? amendment.proposedEffectiveDate,
      frequency: input.counterTerms.frequency,
      feeAllocation: input.counterTerms.feeAllocation,
      terms,
    });
    const auditId = await this.recordAudit(updated, input.actingUserId, "amendment_countered", null);
    // The countering party (`role`) is now the amendment's own proposingPartyRole; notify whoever
    // is *not* that role — the party who must review the new counter-terms.
    const counterpartyRole: PartyRole = role === "creditor" ? "debtor" : "creditor";
    await this.notifyParty(detail.agreement, counterpartyRole, "amendment", { changeType: amendment.changeType }, auditId);
    return updated;
  }

  async withdrawAmendment(input: { amendmentId: string; actingUserId: string; reason?: string }): Promise<AmendmentRecord> {
    const amendment = await this.requireAmendment(input.amendmentId);
    if (amendment.status !== "proposed" && amendment.status !== "awaiting_signatures") {
      throw new ValidationError("Only a proposed or awaiting-signatures amendment can be withdrawn.");
    }
    const role = await this.deps.agreementService.resolvePartyRole(amendment.agreementId, input.actingUserId);
    if (role !== amendment.proposingPartyRole) {
      throw new ForbiddenError("Only the party who proposed this amendment may withdraw it.");
    }
    const updated = await this.deps.amendments.recordWithdrawal(amendment.id, input.reason ?? null);
    await this.recordAudit(updated, input.actingUserId, "amendment_withdrawn", { reason: input.reason ?? null });
    return updated;
  }

  /**
   * Dual-signature collection, mirroring `AgreementService.signAgreement`'s exact per-role gating.
   * Once both signatures are present, immediately applies the amendment (see `applyAmendment`) —
   * there is no separate manual "apply" step, matching this sprint's "Every accepted change creates
   * a new immutable version" with no gap between "signed" and "applied."
   *
   * `ipAddress`/`deviceInfo` are optional but, when the caller (the route) supplies them, recorded
   * on this specific action's audit entry — added during this sprint's own Product Owner review
   * pass to strengthen the evidentiary trail for signing specifically, the highest-stakes single
   * action in this flow, without taking on Sprint 6's full IP/device/consent/step-up evidence
   * bundle (`SignatureService`) wholesale — see `docs/SPRINT_CONTROL.md`'s "Sprint 14 implementation
   * notes" for why that fuller integration remains a documented, separate scope decision.
   */
  async signAmendment(input: {
    amendmentId: string;
    actingUserId: string;
    ipAddress?: string | null;
    deviceInfo?: unknown;
  }): Promise<AmendmentRecord> {
    const amendment = await this.requireAmendment(input.amendmentId);
    if (amendment.status !== "awaiting_signatures") {
      throw new ValidationError(`This action requires status "awaiting_signatures", but the amendment is "${amendment.status}".`);
    }
    const role = await this.deps.agreementService.resolvePartyRole(amendment.agreementId, input.actingUserId);
    if (role === "creditor" && amendment.creditorSignedAt) {
      throw new ValidationError("The creditor has already signed this amendment.");
    }
    if (role === "debtor" && amendment.debtorSignedAt) {
      throw new ValidationError("The debtor has already signed this amendment.");
    }

    const context = { ipAddress: input.ipAddress ?? null, deviceInfo: input.deviceInfo ?? null };
    const now = new Date();
    const signed = await this.deps.amendments.recordSignature(amendment.id, role, now);
    const signAuditId = await this.recordAudit(signed, input.actingUserId, "amendment_signed_by_party", { role }, context);

    const bothSigned = (role === "creditor" || signed.creditorSignedAt) && (role === "debtor" || signed.debtorSignedAt);
    if (!bothSigned) {
      const detail = await this.deps.agreementService.getAgreement(amendment.agreementId, input.actingUserId);
      const otherRole: PartyRole = role === "creditor" ? "debtor" : "creditor";
      await this.notifyParty(detail.agreement, otherRole, "agreement_counterparty_signed", { context: "amendment" }, signAuditId);
      return signed;
    }

    const locked = await this.deps.amendments.updateStatus(signed.id, "signed");
    await this.recordAudit(locked, input.actingUserId, "amendment_fully_signed", null, context);
    return this.applyAmendment(locked, input.actingUserId);
  }

  /**
   * "Every accepted change creates a new immutable version" — the sole place a new `agreement_version`
   * is ever created from an amendment. The prior version is never edited: this only ever inserts a
   * new row, mirroring `AgreementService.createDraft`/`signAgreement`'s own version-creation exactly
   * (same schedule computation), so "original preserved" holds by construction.
   *
   * PRSprint 11: every write below (new version, its schedule, the agreement's current-version
   * pointer, its status, and the amendment's own "applied" marker) happens inside one call to
   * `AmendmentApplicationRepository.applyAtomically` — see that interface's own doc comment for why
   * this used to be 7 separate, non-transactional calls and what could go wrong if one failed
   * partway through.
   */
  private async applyAmendment(amendment: AmendmentRecord, actingUserId: string): Promise<AmendmentRecord> {
    const detail = await this.deps.agreementService.getAgreement(amendment.agreementId, actingUserId);
    if (!detail.agreement.currentVersionId) {
      throw new ValidationError("This agreement has no current version to amend.");
    }
    const currentVersion = await this.deps.versions.findById(detail.agreement.currentVersionId);
    if (!currentVersion) {
      throw new ValidationError("This agreement's current version could not be found.");
    }

    const versionNumber = currentVersion.versionNumber + 1;
    const computed = computeSchedule({
      currentPrincipalMinorUnits: amendment.terms.currentPrincipalMinorUnits,
      firstPaymentMinorUnits: amendment.terms.firstPaymentMinorUnits,
      installmentAmountMinorUnits: amendment.terms.installmentAmountMinorUnits,
      frequency: amendment.frequency,
      firstPaymentDate: amendment.terms.firstPaymentDate,
    });
    // Computable before the row exists — computeVersionHash only depends on agreementId/versionNumber/
    // terms, never a DB-generated id — so the atomic write below can insert the version already locked.
    const documentHash = computeVersionHash({ agreementId: amendment.agreementId, versionNumber, terms: amendment.terms });

    const { agreementVersionId, amendment: applied } = await this.deps.application.applyAtomically({
      agreementId: amendment.agreementId,
      amendmentId: amendment.id,
      versionNumber,
      parentVersionId: currentVersion.id,
      frequency: amendment.frequency,
      feeAllocation: amendment.feeAllocation,
      terms: amendment.terms,
      scheduleItems: computed.items,
      creditorSignedAt: amendment.creditorSignedAt,
      debtorSignedAt: amendment.debtorSignedAt,
      documentHash,
      signedAt: amendment.signedAt ?? new Date(),
      pauseAgreement: amendment.changeType === "temporary_pause",
    });

    const auditId = await this.recordAudit(applied, actingUserId, "amendment_applied", { resultingVersionId: agreementVersionId, versionNumber });
    await Promise.all([
      this.notifyParty(detail.agreement, "creditor", "amendment_decided", { decision: "applied" }, auditId),
      this.notifyParty(detail.agreement, "debtor", "amendment_decided", { decision: "applied" }, auditId),
    ]);
    return applied;
  }

  async getAmendment(amendmentId: string, actingUserId: string): Promise<AmendmentRecord> {
    const amendment = await this.requireAmendment(amendmentId);
    await this.deps.agreementService.resolvePartyRole(amendment.agreementId, actingUserId);
    return amendment;
  }

  async listAmendments(agreementId: string, actingUserId: string): Promise<AmendmentRecord[]> {
    await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    return this.deps.amendments.listForAgreement(agreementId);
  }

  private async requireAmendment(amendmentId: string): Promise<AmendmentRecord> {
    const amendment = await this.deps.amendments.findById(amendmentId);
    if (!amendment) throw new ValidationError("Amendment not found.");
    return amendment;
  }

  /** Returns the created audit event's own id — PRSprint 13 uses this as the notification dedupeKey's uniqueness marker, mirroring AgreementService.recordAudit's identical rationale (an amendment can legitimately cycle through counter-proposals, so a key scoped only to type+amendment+status would wrongly deduplicate away later, equally-legitimate rounds). */
  private async recordAudit(
    amendment: AmendmentRecord,
    actorUserId: string,
    action: string,
    newValue: unknown,
    context?: { ipAddress: string | null; deviceInfo: unknown },
  ): Promise<number> {
    const event = await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: amendment.proposedByProfileKind,
      profileId: amendment.proposedByProfileId,
      agreementId: amendment.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: context?.ipAddress ?? null,
      deviceInfo: context?.deviceInfo ?? null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "amendment",
      targetResourceId: amendment.id,
    });
    return event.id;
  }

  /**
   * PRSprint 13: notifies the given party role's account owner — mirrors
   * AgreementService.notifyParty's identical shape/rationale (optional dependency, own try/catch,
   * called only after the write it's reporting on already committed).
   */
  private async notifyParty(
    agreement: AgreementRecord,
    role: PartyRole,
    notificationType: "amendment" | "amendment_decided" | "agreement_counterparty_signed",
    payload: Record<string, unknown>,
    uniqueId: number | string,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      const profile =
        role === "creditor"
          ? { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId }
          : { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId };
      const recipientUserId = await this.deps.profileOwners.getOwnerUserId(profile.kind, profile.id);
      if (!recipientUserId) return;
      await this.deps.notifications.notify({
        recipientUserId,
        notificationType,
        relatedAgreementId: agreement.id,
        payload,
        dedupeKey: `${notificationType}:${agreement.id}:amend:${uniqueId}:${recipientUserId}`,
      });
    } catch (error) {
      logger.error("amendment_notification_failed", {
        agreementId: agreement.id,
        notificationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
