import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { AgreementService, PartyRole } from "@/lib/agreements/agreementService";

export type PartialPaymentRequestStatus = "proposed" | "awaiting_payment" | "applied" | "rejected" | "expired";

export interface PartialPaymentRequestRecord {
  id: string;
  agreementId: string;
  installmentScheduleItemId: string | null;
  status: PartialPaymentRequestStatus;
  proposingPartyRole: PartyRole;
  proposedByProfileKind: ProfileKind;
  proposedByProfileId: string;
  proposedAmountMinorUnits: number;
  proposedDate: string;
  explanation: string | null;
  remainderTreatment: string | null;
  rejectedReason: string | null;
  rejectedAt: Date | null;
  paymentAttemptId: string | null;
  appliedAt: Date | null;
  expiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzlePartialPaymentRepository. */
export interface PartialPaymentRequestRepository {
  insert(input: {
    agreementId: string;
    installmentScheduleItemId: string | null;
    proposingPartyRole: PartyRole;
    proposedByProfileKind: ProfileKind;
    proposedByProfileId: string;
    proposedAmountMinorUnits: number;
    proposedDate: string;
    explanation: string | null;
    remainderTreatment: string | null;
  }): Promise<PartialPaymentRequestRecord>;
  findById(id: string): Promise<PartialPaymentRequestRecord | null>;
  listForAgreement(agreementId: string): Promise<PartialPaymentRequestRecord[]>;
  /** Counter — mutates the same row's proposed content in place, mirroring AmendmentService.decideAmendment's identical mechanic. */
  updateProposedContent(
    id: string,
    input: {
      proposingPartyRole: PartyRole;
      proposedByProfileKind: ProfileKind;
      proposedByProfileId: string;
      proposedAmountMinorUnits: number;
      proposedDate: string;
      explanation: string | null;
      remainderTreatment: string | null;
    },
  ): Promise<PartialPaymentRequestRecord>;
  updateStatus(id: string, status: PartialPaymentRequestStatus): Promise<PartialPaymentRequestRecord>;
  recordRejection(id: string, reason: string | null): Promise<PartialPaymentRequestRecord>;
  recordApplied(id: string, paymentAttemptId: string): Promise<PartialPaymentRequestRecord>;
  recordExpired(id: string): Promise<PartialPaymentRequestRecord>;
  /** Cron-scan entry point, mirroring PaymentRetryRepository.findDueForFiring's precedent. */
  findAwaitingPaymentPastDate(now: Date): Promise<PartialPaymentRequestRecord[]>;
}

/**
 * Narrow, consumer-defined view onto a payment_attempt — this module only ever needs to confirm a
 * specific attempt succeeded and for how much, never anything else PaymentService exposes. Mirrors
 * this codebase's interface-segregation precedent (e.g. AgreementTermsReader).
 */
export interface PaymentAttemptReader {
  findById(id: string): Promise<{ id: string; status: string; amountMinorUnits: number } | null>;
}

export interface PartialPaymentServiceDeps {
  agreementService: AgreementService;
  requests: PartialPaymentRequestRepository;
  payments: PaymentAttemptReader;
  audit: AuditService;
}

/**
 * Sprint 15 (docs/sprints/SPRINT_15_ PartialPayments_Settlement.md): implements master spec §11 and
 * `docs/STATE_MACHINES.md` §5's Partial-payment request lifecycle (collapsed — see partialPayment.ts's
 * doc comment and enums.ts's `partialPaymentRequestStatusEnum` for the exact collapsing rationale).
 *
 * "Partial payments are allowed only after creditor approval" and "the borrower submits... the
 * creditor may accept, reject, or counteroffer" (§11) is a *narrower* proposer/decider split than
 * Sprint 14's amendment (either party may propose): only the debtor may call `proposePartialPayment`;
 * only the creditor's decision is capability-gated (`approve_partial_payment`, mirroring
 * `AmendmentService.decideAmendment`'s identical `requireCreditorCapability` gate). A creditor
 * counteroffer still flips `proposingPartyRole` so the debtor is the one who must respond next — the
 * counter mechanic itself is identical to Sprint 14's.
 *
 * "Acceptance of a partial payment must not automatically constitute full settlement" and "the
 * remaining balance stays due unless expressly forgiven" (§11) are enforced by construction: nothing
 * in this class ever writes to `agreement.status`, `agreement.current_version_id`, or creates an
 * `agreement_version` — `remainder_treatment` is only ever a free-text record on this row. Forgiving
 * any part of the remaining balance is exclusively `SettlementService`'s concern (a separate,
 * explicit negotiation), never an implicit side effect of a partial payment.
 */
export class PartialPaymentService {
  constructor(private readonly deps: PartialPaymentServiceDeps) {}

  async proposePartialPayment(input: {
    agreementId: string;
    proposedAmountMinorUnits: number;
    proposedDate: string;
    explanation?: string;
    remainderTreatment?: string;
    installmentScheduleItemId?: string;
    actingUserId: string;
  }): Promise<PartialPaymentRequestRecord> {
    const role = await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);
    if (role !== "debtor") {
      throw new ForbiddenError("Only the borrower may propose a partial payment.");
    }
    if (!Number.isInteger(input.proposedAmountMinorUnits) || input.proposedAmountMinorUnits <= 0) {
      throw new ValidationError("proposedAmountMinorUnits must be a positive integer.");
    }
    const detail = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);

    const request = await this.deps.requests.insert({
      agreementId: input.agreementId,
      installmentScheduleItemId: input.installmentScheduleItemId ?? null,
      proposingPartyRole: "debtor",
      proposedByProfileKind: detail.agreement.debtorProfileKind,
      proposedByProfileId: detail.agreement.debtorProfileId,
      proposedAmountMinorUnits: input.proposedAmountMinorUnits,
      proposedDate: input.proposedDate,
      explanation: input.explanation ?? null,
      remainderTreatment: input.remainderTreatment ?? null,
    });
    await this.recordAudit(request, input.actingUserId, "partial_payment_proposed", null);
    return request;
  }

  async decidePartialPayment(input: {
    partialPaymentRequestId: string;
    actingUserId: string;
    decision: "accept" | "reject" | "counter";
    reason?: string;
    counterAmountMinorUnits?: number;
    counterDate?: string;
    counterExplanation?: string;
    counterRemainderTreatment?: string;
  }): Promise<PartialPaymentRequestRecord> {
    const request = await this.requireRequest(input.partialPaymentRequestId);
    if (request.status !== "proposed") {
      throw new ValidationError(`This action requires status "proposed", but the request is "${request.status}".`);
    }

    const role = await this.deps.agreementService.resolvePartyRole(request.agreementId, input.actingUserId);
    if (role === request.proposingPartyRole) {
      throw new ForbiddenError("You proposed this partial payment — only the other party may accept, reject, or counter it.");
    }
    if (role === "creditor") {
      await this.deps.agreementService.requireCreditorCapability(request.agreementId, input.actingUserId, "approve_partial_payment");
    }

    if (input.decision === "accept") {
      const updated = await this.deps.requests.updateStatus(request.id, "awaiting_payment");
      await this.recordAudit(updated, input.actingUserId, "partial_payment_accepted", null);
      return updated;
    }

    if (input.decision === "reject") {
      const updated = await this.deps.requests.recordRejection(request.id, input.reason ?? null);
      await this.recordAudit(updated, input.actingUserId, "partial_payment_rejected", { reason: input.reason ?? null });
      return updated;
    }

    // counter — still "proposed" (unsigned/unaccepted), so mutating this row's own proposed content
    // in place mirrors AmendmentService.decideAmendment's identical counter mechanic.
    if (input.counterAmountMinorUnits === undefined || !input.counterDate) {
      throw new ValidationError("counterAmountMinorUnits and counterDate are required for a counteroffer.");
    }
    if (!Number.isInteger(input.counterAmountMinorUnits) || input.counterAmountMinorUnits <= 0) {
      throw new ValidationError("counterAmountMinorUnits must be a positive integer.");
    }
    const detail = await this.deps.agreementService.getAgreement(request.agreementId, input.actingUserId);
    const counterer = role === "creditor" ? detail.agreement.creditorProfileKind : detail.agreement.debtorProfileKind;
    const countererId = role === "creditor" ? detail.agreement.creditorProfileId : detail.agreement.debtorProfileId;

    const updated = await this.deps.requests.updateProposedContent(request.id, {
      proposingPartyRole: role,
      proposedByProfileKind: counterer,
      proposedByProfileId: countererId,
      proposedAmountMinorUnits: input.counterAmountMinorUnits,
      proposedDate: input.counterDate,
      explanation: input.counterExplanation ?? request.explanation,
      remainderTreatment: input.counterRemainderTreatment ?? request.remainderTreatment,
    });
    await this.recordAudit(updated, input.actingUserId, "partial_payment_countered", null);
    return updated;
  }

  /**
   * Links an already-succeeded payment_attempt (created through the normal PaymentService/
   * AchPaymentService/DebitCardPaymentService gate — never a separate money-movement path) as this
   * request's partial payment, matching §5's "Applied does not itself change agreement status beyond
   * recording the partial payment against the installment."
   */
  async recordPayment(input: { partialPaymentRequestId: string; paymentAttemptId: string; actingUserId: string }): Promise<PartialPaymentRequestRecord> {
    const request = await this.requireRequest(input.partialPaymentRequestId);
    if (request.status !== "awaiting_payment") {
      throw new ValidationError(`This action requires status "awaiting_payment", but the request is "${request.status}".`);
    }
    await this.deps.agreementService.resolvePartyRole(request.agreementId, input.actingUserId);

    const attempt = await this.deps.payments.findById(input.paymentAttemptId);
    if (!attempt || attempt.status !== "succeeded") {
      throw new ValidationError("A succeeded payment is required to apply a partial payment.");
    }
    if (attempt.amountMinorUnits !== request.proposedAmountMinorUnits) {
      throw new ValidationError("The linked payment does not match the agreed partial payment amount.");
    }

    const updated = await this.deps.requests.recordApplied(request.id, attempt.id);
    await this.recordAudit(updated, input.actingUserId, "partial_payment_applied", { paymentAttemptId: attempt.id });
    return updated;
  }

  /**
   * Cron-firing entry point (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md's established
   * "background job/scheduler abstraction" precedent — Vercel has no persistent worker process).
   * "AwaitingPayment --> Expired: not paid within proposed window" (`docs/STATE_MACHINES.md` §5) —
   * `proposedDate` is that window's boundary.
   */
  async expireOverdue(now: Date = new Date()): Promise<{ expired: number }> {
    const due = await this.deps.requests.findAwaitingPaymentPastDate(now);
    for (const request of due) {
      const updated = await this.deps.requests.recordExpired(request.id);
      await this.recordAudit(updated, null, "partial_payment_expired", null);
    }
    return { expired: due.length };
  }

  async getPartialPaymentRequest(partialPaymentRequestId: string, actingUserId: string): Promise<PartialPaymentRequestRecord> {
    const request = await this.requireRequest(partialPaymentRequestId);
    await this.deps.agreementService.resolvePartyRole(request.agreementId, actingUserId);
    return request;
  }

  async listPartialPaymentRequests(agreementId: string, actingUserId: string): Promise<PartialPaymentRequestRecord[]> {
    await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    return this.deps.requests.listForAgreement(agreementId);
  }

  private async requireRequest(id: string): Promise<PartialPaymentRequestRecord> {
    const request = await this.deps.requests.findById(id);
    if (!request) throw new ValidationError("Partial payment request not found.");
    return request;
  }

  private async recordAudit(
    request: PartialPaymentRequestRecord,
    actorUserId: string | null,
    action: string,
    newValue: unknown,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      // Mirrors PaymentWebhookService's "actorUserId: null" precedent for system-initiated events —
      // expireOverdue is the only caller that passes null here.
      actorRole: actorUserId ? "agreement_party" : "scheduler",
      profileKind: actorUserId ? request.proposedByProfileKind : null,
      profileId: actorUserId ? request.proposedByProfileId : null,
      agreementId: request.agreementId,
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
      targetResourceType: "partial_payment_request",
      targetResourceId: request.id,
    });
  }
}
