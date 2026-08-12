import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { AgreementRepository, AgreementService, PartyRole } from "@/lib/agreements/agreementService";
import type { MfaService } from "@/lib/auth/mfaService";

export type SettlementProposalStatus = "proposed" | "awaiting_payment" | "rejected" | "completed" | "failure_consequence_applied";
export type SettlementPaymentMode = "one_time" | "scheduled";
export type SettlementFailureConsequence = "restore_original" | "restore_stated" | "forgive_permanently" | "prior_agreement_controls";

export interface SettlementTerms {
  preSettlementBalanceMinorUnits: number;
  settlementAmountMinorUnits: number;
  forgivenAmountMinorUnits: number;
  deadline: string;
  paymentMode: SettlementPaymentMode;
  failureConsequence: SettlementFailureConsequence;
  /** Required only for restore_stated (the restored balance) / forgive_permanently (the forgiven amount). */
  failureConsequenceStatedAmountMinorUnits?: number;
}

export interface SettlementProposalRecord extends Omit<SettlementTerms, "failureConsequenceStatedAmountMinorUnits"> {
  id: string;
  agreementId: string;
  status: SettlementProposalStatus;
  proposingPartyRole: PartyRole;
  proposedByProfileKind: ProfileKind;
  proposedByProfileId: string;
  failureConsequenceStatedAmountMinorUnits: number | null;
  rejectedReason: string | null;
  rejectedAt: Date | null;
  acceptedAt: Date | null;
  completedAt: Date | null;
  resolvedConsequence: SettlementFailureConsequence | null;
  resolvedRestoredBalanceMinorUnits: number | null;
  resolvedForgivenAmountMinorUnits: number | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleSettlementRepository. */
/** SettlementTerms with its one optional field normalized to explicit null — every repository boundary stores/returns null rather than undefined for "not set." */
export type NormalizedSettlementTerms = Omit<SettlementTerms, "failureConsequenceStatedAmountMinorUnits"> & {
  failureConsequenceStatedAmountMinorUnits: number | null;
};

export interface SettlementProposalRepository {
  insert(input: {
    agreementId: string;
    proposingPartyRole: PartyRole;
    proposedByProfileKind: ProfileKind;
    proposedByProfileId: string;
  } & NormalizedSettlementTerms): Promise<SettlementProposalRecord>;
  findById(id: string): Promise<SettlementProposalRecord | null>;
  listForAgreement(agreementId: string): Promise<SettlementProposalRecord[]>;
  /** Counter — mutates the same row's proposed terms in place, mirroring AmendmentService.decideAmendment's identical mechanic. */
  updateProposedContent(
    id: string,
    input: { proposingPartyRole: PartyRole; proposedByProfileKind: ProfileKind; proposedByProfileId: string } & NormalizedSettlementTerms,
  ): Promise<SettlementProposalRecord>;
  recordAccepted(id: string): Promise<SettlementProposalRecord>;
  recordRejection(id: string, reason: string | null): Promise<SettlementProposalRecord>;
  recordCompleted(id: string): Promise<SettlementProposalRecord>;
  recordFailureConsequence(
    id: string,
    input: {
      resolvedConsequence: SettlementFailureConsequence;
      resolvedRestoredBalanceMinorUnits: number | null;
      resolvedForgivenAmountMinorUnits: number | null;
    },
  ): Promise<SettlementProposalRecord>;
  /** Cron-scan entry point, mirroring PaymentRetryRepository.findDueForFiring's precedent. */
  findAwaitingPaymentPastDeadline(now: Date): Promise<SettlementProposalRecord[]>;
}

/** Links succeeded payment_attempts collected toward a settlement — see settlement.ts's doc comment. */
export interface SettlementPaymentRepository {
  insert(input: { settlementProposalId: string; paymentAttemptId: string; amountMinorUnits: number }): Promise<void>;
  isPaymentLinked(paymentAttemptId: string): Promise<boolean>;
  sumForSettlement(settlementProposalId: string): Promise<number>;
}

/**
 * Narrow, consumer-defined view onto a payment_attempt — mirrors PartialPaymentService's identical
 * PaymentAttemptReader (this codebase's interface-segregation precedent, e.g. AgreementTermsReader).
 */
export interface PaymentAttemptReader {
  findById(id: string): Promise<{ id: string; status: string; amountMinorUnits: number } | null>;
}

export interface SettlementServiceDeps {
  agreementService: AgreementService;
  /** Direct write access for the one place this service ever touches agreement.status — mirrors AmendmentService's identical `agreements` dependency for its own paused_by_amendment write. */
  agreements: AgreementRepository;
  proposals: SettlementProposalRepository;
  settlementPayments: SettlementPaymentRepository;
  payments: PaymentAttemptReader;
  mfa: MfaService;
  audit: AuditService;
}

function validateTerms(terms: SettlementTerms): void {
  if (!Number.isInteger(terms.preSettlementBalanceMinorUnits) || terms.preSettlementBalanceMinorUnits <= 0) {
    throw new ValidationError("preSettlementBalanceMinorUnits must be a positive integer.");
  }
  if (!Number.isInteger(terms.settlementAmountMinorUnits) || terms.settlementAmountMinorUnits <= 0) {
    throw new ValidationError("settlementAmountMinorUnits must be a positive integer.");
  }
  if (terms.settlementAmountMinorUnits >= terms.preSettlementBalanceMinorUnits) {
    throw new ValidationError("settlementAmountMinorUnits must be less than preSettlementBalanceMinorUnits.");
  }
  if (terms.forgivenAmountMinorUnits !== terms.preSettlementBalanceMinorUnits - terms.settlementAmountMinorUnits) {
    throw new ValidationError("forgivenAmountMinorUnits must equal preSettlementBalanceMinorUnits minus settlementAmountMinorUnits.");
  }
  if (terms.failureConsequence === "restore_stated" || terms.failureConsequence === "forgive_permanently") {
    const stated = terms.failureConsequenceStatedAmountMinorUnits;
    if (stated === undefined || !Number.isInteger(stated) || stated < 0) {
      throw new ValidationError(`A non-negative failureConsequenceStatedAmountMinorUnits is required for the "${terms.failureConsequence}" failure consequence.`);
    }
  }
}

/**
 * Sprint 15 (docs/sprints/SPRINT_15_ PartialPayments_Settlement.md): implements master spec §12 and
 * `docs/STATE_MACHINES.md` §6's Settlement lifecycle. See settlement.ts's doc comment for why this
 * table's own `proposed → accepted → awaiting_payment` collapses §6's illustrative
 * `AmendmentInProgress` sub-phase rather than handing off to `AmendmentService` — no new
 * `agreement_version` is ever created for a settlement.
 *
 * "After the settlement successfully clears, the status must be Settled in Full rather than Paid in
 * Full" (§12) is enforced by construction: `recordSettlementPayment` is the ONLY place this class
 * ever calls `agreements.updateStatus`, and it only ever passes `"settled_in_full"` — there is no
 * code path in this class capable of writing `"paid_in_full"`.
 *
 * "Approving a settlement is a master-spec-listed MFA-gated action. Call Sprint 2's
 * requireStepUp(user, 'approve_settlement') before finalizing creditor acceptance of a settlement. Do
 * not implement a second, competing authentication mechanism" (this sprint's own instruction text) is
 * implemented via the single shared `requireCreditorStepUp` helper — never a bespoke MFA/step-up
 * check of its own — called from every creditor action capable of fixing binding-capable settlement
 * terms: `proposeSettlement`, `decideSettlement`'s "counter" branch, and `decideSettlement`'s "accept"
 * branch (the literal action the instruction names). This was widened from "accept" alone during this
 * sprint's Product Owner review pass — see `docs/SPRINT_CONTROL.md`'s Sprint 15 Product Owner review
 * pass notes for why the narrower reading left a real gap (a creditor-*proposed* or creditor-countered
 * settlement the debtor simply accepts would otherwise bind the creditor's forgiveness commitment with
 * no step-up ever exercised on the creditor's side).
 */
export class SettlementService {
  constructor(private readonly deps: SettlementServiceDeps) {}

  async proposeSettlement(
    input: SettlementTerms & { agreementId: string; actingUserId: string; actingSessionId?: string },
  ): Promise<SettlementProposalRecord> {
    const role = await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);
    const detail = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);
    validateTerms(input);

    // A creditor-authored proposal already fixes the forgiveness amount the debtor need only accept
    // as-is to bind — gated the same way `decideSettlement`'s creditor "accept" is, for both the
    // same reasons: the `approve_settlement` capability (so a business-staff member without it can't
    // bind the business to a settlement merely by proposing terms the debtor then accepts — decide's
    // own capability check only fires when the *creditor* is deciding, never when the debtor accepts
    // a creditor-authored proposal) and step-up (see requireCreditorStepUp's doc comment).
    if (role === "creditor") {
      await this.deps.agreementService.requireCreditorCapability(input.agreementId, input.actingUserId, "approve_settlement");
      await this.requireCreditorStepUp(input.actingUserId, input.actingSessionId);
    }

    const proposer = role === "creditor" ? detail.agreement.creditorProfileKind : detail.agreement.debtorProfileKind;
    const proposerId = role === "creditor" ? detail.agreement.creditorProfileId : detail.agreement.debtorProfileId;

    const proposal = await this.deps.proposals.insert({
      agreementId: input.agreementId,
      proposingPartyRole: role,
      proposedByProfileKind: proposer,
      proposedByProfileId: proposerId,
      preSettlementBalanceMinorUnits: input.preSettlementBalanceMinorUnits,
      settlementAmountMinorUnits: input.settlementAmountMinorUnits,
      forgivenAmountMinorUnits: input.forgivenAmountMinorUnits,
      deadline: input.deadline,
      paymentMode: input.paymentMode,
      failureConsequence: input.failureConsequence,
      failureConsequenceStatedAmountMinorUnits: input.failureConsequenceStatedAmountMinorUnits ?? null,
    });
    await this.recordAudit(proposal, input.actingUserId, "settlement_proposed", null);
    return proposal;
  }

  async decideSettlement(input: {
    settlementProposalId: string;
    actingUserId: string;
    actingSessionId?: string;
    decision: "accept" | "reject" | "counter";
    reason?: string;
    counterTerms?: SettlementTerms;
  }): Promise<SettlementProposalRecord> {
    const proposal = await this.requireProposal(input.settlementProposalId);
    if (proposal.status !== "proposed") {
      throw new ValidationError(`This action requires status "proposed", but the settlement is "${proposal.status}".`);
    }

    const role = await this.deps.agreementService.resolvePartyRole(proposal.agreementId, input.actingUserId);
    if (role === proposal.proposingPartyRole) {
      throw new ForbiddenError("You proposed this settlement — only the other party may accept, reject, or counter it.");
    }
    if (role === "creditor") {
      await this.deps.agreementService.requireCreditorCapability(proposal.agreementId, input.actingUserId, "approve_settlement");
    }

    if (input.decision === "accept") {
      if (role === "creditor") {
        await this.requireCreditorStepUp(input.actingUserId, input.actingSessionId);
      }
      const updated = await this.deps.proposals.recordAccepted(proposal.id);
      await this.recordAudit(updated, input.actingUserId, "settlement_accepted", null);
      return updated;
    }

    if (input.decision === "reject") {
      const updated = await this.deps.proposals.recordRejection(proposal.id, input.reason ?? null);
      await this.recordAudit(updated, input.actingUserId, "settlement_rejected", { reason: input.reason ?? null });
      return updated;
    }

    // counter — still "proposed", so mutating this row's own proposed terms in place mirrors
    // AmendmentService.decideAmendment's identical counter mechanic. A creditor counter fixes new
    // binding-capable terms exactly like a creditor proposal does, so it is gated the same way.
    if (!input.counterTerms) {
      throw new ValidationError("counterTerms is required for a counteroffer.");
    }
    if (role === "creditor") {
      await this.requireCreditorStepUp(input.actingUserId, input.actingSessionId);
    }
    validateTerms(input.counterTerms);
    const detail = await this.deps.agreementService.getAgreement(proposal.agreementId, input.actingUserId);
    const counterer = role === "creditor" ? detail.agreement.creditorProfileKind : detail.agreement.debtorProfileKind;
    const countererId = role === "creditor" ? detail.agreement.creditorProfileId : detail.agreement.debtorProfileId;

    const updated = await this.deps.proposals.updateProposedContent(proposal.id, {
      proposingPartyRole: role,
      proposedByProfileKind: counterer,
      proposedByProfileId: countererId,
      preSettlementBalanceMinorUnits: input.counterTerms.preSettlementBalanceMinorUnits,
      settlementAmountMinorUnits: input.counterTerms.settlementAmountMinorUnits,
      forgivenAmountMinorUnits: input.counterTerms.forgivenAmountMinorUnits,
      deadline: input.counterTerms.deadline,
      paymentMode: input.counterTerms.paymentMode,
      failureConsequence: input.counterTerms.failureConsequence,
      failureConsequenceStatedAmountMinorUnits: input.counterTerms.failureConsequenceStatedAmountMinorUnits ?? null,
    });
    await this.recordAudit(updated, input.actingUserId, "settlement_countered", null);
    return updated;
  }

  /**
   * Links an already-succeeded payment_attempt toward this settlement (never a separate
   * money-movement path — see PartialPaymentService.recordPayment's identical reasoning), supporting
   * both one-time and scheduled payment modes (§12). Once the linked total meets or exceeds the full
   * settlement amount, completes the settlement and — the one and only place this ever happens —
   * marks the agreement `settled_in_full`, never `paid_in_full`.
   */
  async recordSettlementPayment(input: { settlementProposalId: string; paymentAttemptId: string; actingUserId: string }): Promise<SettlementProposalRecord> {
    const proposal = await this.requireProposal(input.settlementProposalId);
    if (proposal.status !== "awaiting_payment") {
      throw new ValidationError(`This action requires status "awaiting_payment", but the settlement is "${proposal.status}".`);
    }
    await this.deps.agreementService.resolvePartyRole(proposal.agreementId, input.actingUserId);

    const attempt = await this.deps.payments.findById(input.paymentAttemptId);
    if (!attempt || attempt.status !== "succeeded") {
      throw new ValidationError("A succeeded payment is required to record it against a settlement.");
    }
    if (proposal.paymentMode === "one_time" && attempt.amountMinorUnits !== proposal.settlementAmountMinorUnits) {
      throw new ValidationError("A one-time settlement payment must equal the full settlement amount.");
    }
    if (await this.deps.settlementPayments.isPaymentLinked(attempt.id)) {
      throw new ValidationError("This payment has already been recorded against a settlement.");
    }

    await this.deps.settlementPayments.insert({ settlementProposalId: proposal.id, paymentAttemptId: attempt.id, amountMinorUnits: attempt.amountMinorUnits });
    await this.recordAudit(proposal, input.actingUserId, "settlement_payment_recorded", { paymentAttemptId: attempt.id, amountMinorUnits: attempt.amountMinorUnits });

    const totalCollected = await this.deps.settlementPayments.sumForSettlement(proposal.id);
    if (totalCollected < proposal.settlementAmountMinorUnits) {
      return this.requireProposal(proposal.id);
    }

    const completed = await this.deps.proposals.recordCompleted(proposal.id);
    await this.deps.agreements.updateStatus(proposal.agreementId, "settled_in_full");
    await this.recordAudit(completed, input.actingUserId, "settlement_completed", { totalCollectedMinorUnits: totalCollected });
    return completed;
  }

  /**
   * Cron-firing entry point (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md's established
   * "background job/scheduler abstraction" precedent). "AwaitingSettlementPayment -->
   * FailureConsequenceApplied: deadline passes incomplete" (`docs/STATE_MACHINES.md` §6) — applies
   * exactly the consequence chosen at proposal time, never a substitute (§6's own invalid-transition
   * note).
   */
  async expireOverdueSettlements(now: Date = new Date()): Promise<{ resolved: number }> {
    const due = await this.deps.proposals.findAwaitingPaymentPastDeadline(now);
    for (const proposal of due) {
      const totalCollected = await this.deps.settlementPayments.sumForSettlement(proposal.id);
      if (totalCollected >= proposal.settlementAmountMinorUnits) {
        // Defensive only — recordSettlementPayment already completes a settlement the instant the
        // full amount clears, so this should never actually be reached in practice.
        const completed = await this.deps.proposals.recordCompleted(proposal.id);
        await this.deps.agreements.updateStatus(proposal.agreementId, "settled_in_full");
        await this.recordAudit(completed, null, "settlement_completed", { totalCollectedMinorUnits: totalCollected });
        continue;
      }
      const resolution = resolveFailureConsequence(proposal, totalCollected);
      const applied = await this.deps.proposals.recordFailureConsequence(proposal.id, resolution);
      await this.recordAudit(applied, null, "settlement_failure_consequence_applied", { ...resolution, totalCollectedMinorUnits: totalCollected });
    }
    return { resolved: due.length };
  }

  async getSettlementProposal(settlementProposalId: string, actingUserId: string): Promise<SettlementProposalRecord> {
    const proposal = await this.requireProposal(settlementProposalId);
    await this.deps.agreementService.resolvePartyRole(proposal.agreementId, actingUserId);
    return proposal;
  }

  async listSettlementProposals(agreementId: string, actingUserId: string): Promise<SettlementProposalRecord[]> {
    await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    return this.deps.proposals.listForAgreement(agreementId);
  }

  /**
   * Gates every creditor action capable of fixing binding-capable settlement terms — proposing,
   * countering, or finalizing acceptance — not just the literal "creditor accepts" decision this
   * sprint's instruction text names as an example. Master spec §17 requires "elevated authentication
   * and authorization" for "significant settlements" (the settlement itself, not one specific click),
   * and §26 separately lists both "Approving settlements" and "Forgiving debt" as MFA-required
   * actions. Without this, a creditor-*proposed* settlement (or creditor counter) the debtor simply
   * accepts as-is would bind the creditor's forgiveness commitment with no step-up ever exercised on
   * the creditor's side — a real gap found and closed in this sprint's Product Owner review pass, not
   * present in the original implementation. Still exactly one authentication mechanism
   * (`MfaService.requireStepUp`), per this sprint's own "do not implement a second, competing
   * authentication mechanism."
   */
  private async requireCreditorStepUp(actingUserId: string, actingSessionId: string | undefined): Promise<void> {
    if (!actingSessionId) {
      throw new ValidationError("A session is required to perform this settlement action as the creditor.");
    }
    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: actingUserId,
      sessionId: actingSessionId,
      action: "approve_settlement",
    });
    if (!stepUpOk) {
      throw new ForbiddenError("Step-up verification is required to propose, counter, or accept a settlement as the creditor.");
    }
  }

  private async requireProposal(id: string): Promise<SettlementProposalRecord> {
    const proposal = await this.deps.proposals.findById(id);
    if (!proposal) throw new ValidationError("Settlement proposal not found.");
    return proposal;
  }

  private async recordAudit(
    proposal: SettlementProposalRecord,
    actorUserId: string | null,
    action: string,
    newValue: unknown,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      // Mirrors PaymentWebhookService's "actorUserId: null" precedent for system-initiated events —
      // expireOverdueSettlements is the only caller that passes null here.
      actorRole: actorUserId ? "agreement_party" : "scheduler",
      profileKind: actorUserId ? proposal.proposedByProfileKind : null,
      profileId: actorUserId ? proposal.proposedByProfileId : null,
      agreementId: proposal.agreementId,
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
      targetResourceType: "settlement_proposal",
      targetResourceId: proposal.id,
    });
  }
}

function resolveFailureConsequence(
  proposal: SettlementProposalRecord,
  totalCollectedMinorUnits: number,
): {
  resolvedConsequence: SettlementFailureConsequence;
  resolvedRestoredBalanceMinorUnits: number | null;
  resolvedForgivenAmountMinorUnits: number | null;
} {
  switch (proposal.failureConsequence) {
    case "restore_original":
      // Whatever partial settlement payments already cleared reduces the restored balance —
      // otherwise a debtor who paid most of the settlement before missing the deadline would owe
      // the full original balance again, double-counting their cleared payments.
      return {
        resolvedConsequence: "restore_original",
        resolvedRestoredBalanceMinorUnits: proposal.preSettlementBalanceMinorUnits - totalCollectedMinorUnits,
        resolvedForgivenAmountMinorUnits: null,
      };
    case "restore_stated":
      return {
        resolvedConsequence: "restore_stated",
        resolvedRestoredBalanceMinorUnits: proposal.failureConsequenceStatedAmountMinorUnits,
        resolvedForgivenAmountMinorUnits: null,
      };
    case "forgive_permanently":
      return {
        resolvedConsequence: "forgive_permanently",
        resolvedRestoredBalanceMinorUnits: null,
        resolvedForgivenAmountMinorUnits: proposal.failureConsequenceStatedAmountMinorUnits,
      };
    case "prior_agreement_controls":
      // "The prior agreement remains controlling until a new arrangement is negotiated" (master spec
      // §12) — declarative only; nothing numeric to resolve, matching this table's own default state
      // (this class never touched agreement.status or terms during the failed negotiation).
      return {
        resolvedConsequence: "prior_agreement_controls",
        resolvedRestoredBalanceMinorUnits: null,
        resolvedForgivenAmountMinorUnits: null,
      };
  }
}
