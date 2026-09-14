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
  /** Cron-scan entry point, mirroring PaymentRetryRepository.findDueForFiring's precedent. */
  findAwaitingPaymentPastDate(now: Date): Promise<PartialPaymentRequestRecord[]>;
  /**
   * R11 PASS B1 — FINAL TARGETED CORRECTION (Defect 1 — CLEARED PARTIAL PAYMENT IS NOT DURABLY
   * APPLIED). A single, atomic, conditional `awaiting_payment -> applied` transition — see
   * `PartialPaymentAutoApplicationService`'s own doc comment for why an unconditional `recordApplied`
   * (which blindly overwrites whatever is there) is unsafe for duplicate webhook/recovery execution.
   * `"applied"` means THIS call performed the transition just now. `"already_applied_same"` means the
   * request was already `"applied"` to this EXACT `paymentAttemptId` — a safe, successful no-op
   * (duplicate webhook/recovery replay). `"already_applied_different"` means the request was already
   * `"applied"` to a DIFFERENT `paymentAttemptId` — a genuine conflict, NEVER silently overwritten.
   * `"not_awaiting_payment"` covers every other current status (`proposed`/`rejected`/`expired`) —
   * also never overwritten. The single `UPDATE ... WHERE status = 'awaiting_payment'` this performs is
   * atomic by construction (ordinary Postgres row-level MVCC), so two concurrent callers racing the
   * SAME request can never both report `"applied"`.
   */
  applyIfAwaitingPayment(
    id: string,
    paymentAttemptId: string,
  ): Promise<
    | { outcome: "applied"; request: PartialPaymentRequestRecord }
    | { outcome: "already_applied_same"; request: PartialPaymentRequestRecord }
    | { outcome: "already_applied_different"; request: PartialPaymentRequestRecord }
    | { outcome: "not_awaiting_payment"; request: PartialPaymentRequestRecord }
  >;
  /**
   * R11 PASS B1 — ASYNC CORRELATION CORRECTION (Defect 2 — EXPIRATION CHECK/WRITE RACE). Atomic,
   * race-safe expiration: locks the proposal row, then determines FRESH, authoritative
   * payment-clearing evidence for its correlated payment WITHIN THIS SAME transaction/lock (never a
   * separate, pre-transaction read) before ever writing `"expired"` — closing the TOCTOU window
   * where a plain check-then-`UPDATE...WHERE status`, or worse an unconditional `UPDATE...WHERE id`
   * alone, could expire a proposal whose money cleared (or was even fully applied) in between.
   * `"expired"` — this call performed the transition. `"not_awaiting_payment"` — the row had already
   * moved on (e.g. genuinely applied first) by the time the lock was acquired; never overwritten.
   * `"cleared_skip"` — durable clearing evidence exists; correctly left `awaiting_payment` for the
   * normal application path to pick up. `"unknown_skip"` — evidence resolution could not be
   * conclusively determined (Defect 4); fails safe by never expiring rather than guessing.
   */
  expireIfSafe(
    id: string,
  ): Promise<
    | { outcome: "expired"; request: PartialPaymentRequestRecord }
    | { outcome: "not_awaiting_payment"; request: PartialPaymentRequestRecord }
    | { outcome: "cleared_skip" }
    | { outcome: "in_flight_skip" }
    | { outcome: "unknown_skip" }
  >;
}

/**
 * Narrow, consumer-defined view onto a payment_attempt — this module only ever needs to confirm a
 * specific attempt succeeded, for how much, and (R08 B2 — EC1-001 correction) which agreement/parties
 * it actually belongs to, never anything else PaymentService exposes. Mirrors this codebase's
 * interface-segregation precedent (e.g. AgreementTermsReader).
 *
 * `agreementId`/`payerProfileKind`/`payerProfileId`/`recipientProfileKind`/`recipientProfileId` were
 * added by R08 B2 so `recordPayment` can bind a payment attempt back to its canonical agreement and
 * canonical debtor/creditor before ever trusting it to satisfy a partial-payment request — see that
 * method's own doc comment. The concrete production implementation
 * (`DrizzlePaymentAttemptRepository`, wired in `getPartialPaymentService.ts`) already returns the full
 * `PaymentAttemptRecord`, which already carries every one of these fields — no repository change was
 * required.
 */
export interface PaymentAttemptReader {
  findById(id: string): Promise<
    | {
        id: string;
        status: string;
        amountMinorUnits: number;
        installmentScheduleItemId: string | null;
        agreementId: string | null;
        payerProfileKind: ProfileKind;
        payerProfileId: string;
        recipientProfileKind: ProfileKind;
        recipientProfileId: string;
      }
    | null
  >;
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
    // PRSprint 17: Number.isSafeInteger — see schedule.ts's identical hardening rationale.
    if (!Number.isSafeInteger(input.proposedAmountMinorUnits) || input.proposedAmountMinorUnits <= 0) {
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
    if (!Number.isSafeInteger(input.counterAmountMinorUnits) || input.counterAmountMinorUnits <= 0) {
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
   *
   * R08 B2 (EC1-001 correction): a succeeded payment attempt proves money moved somewhere — it proves
   * nothing about whether it moved for THIS agreement, between THIS agreement's own canonical debtor
   * and creditor. Without the three checks below, a succeeded attempt from a completely unrelated
   * agreement (or the right agreement but the wrong payer/recipient) could previously be linked here
   * to falsely mark this request "applied," even though the money never reached this agreement's
   * creditor. This mirrors `SettlementService.recordSettlementPayment`'s own, already-existing
   * "Check 2/3/4" durable-binding precedent (same-agreement + canonical-debtor + canonical-creditor),
   * applied here for the first time. The canonical agreement is loaded and re-authorized via
   * `AgreementService.getAgreement` — never trusted from anything the client supplies (the request
   * body doesn't even carry debtor/creditor fields) — before the payment attempt is ever read, so
   * every comparison below has an authoritative baseline. No mutation (`recordApplied`, the
   * `partial_payment_applied` audit) occurs until every check has passed.
   */
  async recordPayment(input: { partialPaymentRequestId: string; paymentAttemptId: string; actingUserId: string }): Promise<PartialPaymentRequestRecord> {
    const request = await this.requireRequest(input.partialPaymentRequestId);
    if (request.status !== "awaiting_payment") {
      throw new ValidationError(`This action requires status "awaiting_payment", but the request is "${request.status}".`);
    }
    await this.deps.agreementService.resolvePartyRole(request.agreementId, input.actingUserId);
    const { agreement } = await this.deps.agreementService.getAgreement(request.agreementId, input.actingUserId);

    const attempt = await this.deps.payments.findById(input.paymentAttemptId);
    if (!attempt || attempt.status !== "succeeded") {
      throw new ValidationError("A succeeded payment is required to apply a partial payment.");
    }
    if (attempt.agreementId !== request.agreementId) {
      throw new ValidationError("This payment does not belong to this partial payment request's agreement.");
    }
    if (attempt.payerProfileKind !== agreement.debtorProfileKind || attempt.payerProfileId !== agreement.debtorProfileId) {
      throw new ValidationError("This payment's payer does not match this agreement's debtor.");
    }
    if (attempt.recipientProfileKind !== agreement.creditorProfileKind || attempt.recipientProfileId !== agreement.creditorProfileId) {
      throw new ValidationError("This payment's recipient does not match this agreement's creditor.");
    }
    if (attempt.amountMinorUnits !== request.proposedAmountMinorUnits) {
      throw new ValidationError("The linked payment does not match the agreed partial payment amount.");
    }
    // R11 (Final Open Issue A): if this request itself named a target installment, the payment being
    // linked to it must be linked to that SAME installment — otherwise this request could be
    // satisfied by a payment that (per the R11 per-installment invariant) never actually contributes
    // to that installment's own amount-satisfaction, silently reintroducing the exact gap R11 exists
    // to close.
    if (request.installmentScheduleItemId && attempt.installmentScheduleItemId !== request.installmentScheduleItemId) {
      throw new ValidationError("The linked payment is not linked to the installment this partial payment request targets.");
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
   *
   * R11 PASS B1 — FINAL TARGETED CORRECTION (Defect 1, requirement 6 — EXPIRATION SAFETY), extended
   * by R11 PASS B1 — ASYNC CORRELATION CORRECTION (Defect 2 — EXPIRATION CHECK/WRITE RACE): the
   * narrowest possible guard, not a redesign of expiration policy. A real, narrow race exists between
   * a partial-payment attempt's own provider clearing durably posting (or its
   * `awaiting_payment -> applied` association completing) and this cron sweep's own expiration
   * decision. `PartialPaymentRequestRepository.expireIfSafe` closes this atomically — it locks the
   * proposal row and re-derives fresh clearing evidence WITHIN that same transaction/lock before
   * ever writing `"expired"`, never a plain pre-transaction check followed by an unconditional write
   * (see that method's own doc comment for the exact outcomes and why "unknown" evidence never
   * authorizes expiration either — Defect 4). This method never itself performs the application
   * (that remains exclusively the auto-application effect's job, run from the real payment/webhook
   * lifecycle, never from this cron sweep) — only a correctly-atomic decision whether to expire.
   */
  async expireOverdue(now: Date = new Date()): Promise<{ expired: number }> {
    const due = await this.deps.requests.findAwaitingPaymentPastDate(now);
    let expired = 0;
    for (const request of due) {
      const result = await this.deps.requests.expireIfSafe(request.id);
      if (result.outcome === "expired") {
        await this.recordAudit(result.request, null, "partial_payment_expired", null);
        expired += 1;
      }
    }
    return { expired };
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
