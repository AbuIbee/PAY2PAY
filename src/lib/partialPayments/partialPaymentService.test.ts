import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import type { PartialPaymentRequestRecord } from "./partialPaymentService";
import { createTestPartialPaymentService } from "./testFakes";

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

describe("PartialPaymentService", () => {
  let ctx: ReturnType<typeof createTestPartialPaymentService>;
  let creditorUserId: string;
  let debtorUserId: string;
  // R08 B2 (EC1-001): promoted from beforeEach-local consts so recordPayment tests can construct
  // payment-attempt fixtures using the agreement's ACTUAL canonical debtor/creditor, never an
  // unrelated randomUUID() that would now be rejected by the new payer/recipient binding checks.
  let creditorProfileId: string;
  let debtorProfileId: string;
  let agreementId: string;
  let originalVersionId: string;

  beforeEach(async () => {
    ctx = createTestPartialPaymentService();
    creditorUserId = randomUUID();
    debtorUserId = randomUUID();
    creditorProfileId = randomUUID();
    debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);

    // Agreement Lifecycle V2: debtor originates so the creditor is the counterparty and may sign first.
    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    agreementId = created.agreement.id;
    originalVersionId = created.version.id;

    await ctx.agreementCtx.agreementService.submitDraft(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, creditorUserId); // counterparty first
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, debtorUserId); // originator last
  });

  it("proposal: the borrower can propose a partial payment, capturing amount/date/explanation/remainder treatment", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      explanation: "Short on cash this month",
      remainderTreatment: "Remainder stays due on the normal schedule",
      actingUserId: debtorUserId,
    });
    expect(request.status).toBe("proposed");
    expect(request.proposingPartyRole).toBe("debtor");
    expect(request.proposedAmountMinorUnits).toBe(5_000);
    expect(request.proposedDate).toBe("2026-03-01");
    expect(request.explanation).toBe("Short on cash this month");
    expect(request.remainderTreatment).toBe("Remainder stays due on the normal schedule");
  });

  it("only the borrower may propose a partial payment", async () => {
    await expect(
      ctx.partialPaymentService.proposePartialPayment({
        agreementId,
        proposedAmountMinorUnits: 5_000,
        proposedDate: "2026-03-01",
        actingUserId: creditorUserId,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejection: the creditor can reject a proposed partial payment outright", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    const decided = await ctx.partialPaymentService.decidePartialPayment({
      partialPaymentRequestId: request.id,
      actingUserId: creditorUserId,
      decision: "reject",
      reason: "Amount too low",
    });
    expect(decided.status).toBe("rejected");
    expect(decided.rejectedReason).toBe("Amount too low");
  });

  it("counter: the creditor can counter with different terms, mutating the same request and flipping whose turn it is", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    const countered = await ctx.partialPaymentService.decidePartialPayment({
      partialPaymentRequestId: request.id,
      actingUserId: creditorUserId,
      decision: "counter",
      counterAmountMinorUnits: 8_000,
      counterDate: "2026-03-05",
    });
    expect(countered.id).toBe(request.id);
    expect(countered.status).toBe("proposed");
    expect(countered.proposingPartyRole).toBe("creditor");
    expect(countered.proposedAmountMinorUnits).toBe(8_000);

    await expect(
      ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);

    const accepted = await ctx.partialPaymentService.decidePartialPayment({
      partialPaymentRequestId: request.id,
      actingUserId: debtorUserId,
      decision: "accept",
    });
    expect(accepted.status).toBe("awaiting_payment");
  });

  it("unauthorized change blocked: a business-staff creditor without approve_partial_payment cannot decide, but a manager (who has it) can", async () => {
    const creditorBusinessId = randomUUID();
    const creditorOwnerId = randomUUID();
    const debtorProfileId = randomUUID();
    const debtorUserId2 = randomUUID();
    const creditorViewerUserId = randomUUID();
    const creditorManagerUserId = randomUUID();
    ctx.agreementCtx.profileOwners.set("business", creditorBusinessId, creditorOwnerId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId2);
    ctx.agreementCtx.staffCtx.staffMembers.seed({ businessProfileId: creditorBusinessId, userId: creditorViewerUserId, role: "accountant_viewer" });
    ctx.agreementCtx.staffCtx.staffMembers.seed({ businessProfileId: creditorBusinessId, userId: creditorManagerUserId, role: "manager" });

    const b2c = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId2,
      creditor: { kind: "business", id: creditorBusinessId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    await ctx.agreementCtx.agreementService.submitDraft(b2c.agreement.id, creditorOwnerId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(b2c.agreement.id, debtorUserId2);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId: b2c.agreement.id, actingUserId: creditorOwnerId, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(b2c.agreement.id, creditorOwnerId); // counterparty first
    await ctx.agreementCtx.agreementService.signAgreement(b2c.agreement.id, debtorUserId2); // originator last

    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId: b2c.agreement.id,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId2,
    });

    await expect(
      ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorViewerUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);

    const decided = await ctx.partialPaymentService.decidePartialPayment({
      partialPaymentRequestId: request.id,
      actingUserId: creditorManagerUserId,
      decision: "accept",
    });
    expect(decided.status).toBe("awaiting_payment");
  });

  it("recordPayment: a succeeded, matching payment applies the partial payment", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });

    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `pp-${request.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtorProfileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditorProfileId,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
    });

    const applied = await ctx.partialPaymentService.recordPayment({
      partialPaymentRequestId: request.id,
      paymentAttemptId: attempt.id,
      actingUserId: debtorUserId,
    });
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(attempt.id);
  });

  it("recordPayment: rejects a payment whose amount doesn't match the agreed partial payment", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });

    // R08 B2 (EC1-001): payer/recipient deliberately set to the agreement's own canonical debtor/
    // creditor — this test isolates the pre-existing amount-mismatch check, not the new binding checks.
    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `pp-${request.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtorProfileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditorProfileId,
      amountMinorUnits: 4_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
    });

    await expect(
      ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
    ).rejects.toThrow(ValidationError);
  });

  it("recordPayment: rejects a payment that has not succeeded", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });

    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `pp-${request.id}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "processing",
    });

    await expect(
      ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
    ).rejects.toThrow(ValidationError);
  });

  it("acceptance does not forgive the remainder or constitute settlement: the agreement's status and current version are untouched throughout", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      remainderTreatment: "Remainder stays due",
      actingUserId: debtorUserId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });
    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `pp-${request.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtorProfileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditorProfileId,
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
    });
    await ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId });

    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.status).toBe("first_payment_pending");
    expect(agreement?.currentVersionId).toBe(originalVersionId);
  });

  it("expireOverdue: an awaiting-payment request past its proposed date is marked expired", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });

    const result = await ctx.partialPaymentService.expireOverdue(new Date("2026-03-02T00:00:00Z"));
    expect(result.expired).toBe(1);
    const expired = await ctx.requests.findById(request.id);
    expect(expired?.status).toBe("expired");
    expect(expired?.expiredAt).toBeTruthy();
  });

  it("expireOverdue leaves a not-yet-due awaiting-payment request untouched", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-10",
      actingUserId: debtorUserId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });

    const result = await ctx.partialPaymentService.expireOverdue(new Date("2026-03-02T00:00:00Z"));
    expect(result.expired).toBe(0);
    const stillWaiting = await ctx.requests.findById(request.id);
    expect(stillWaiting?.status).toBe("awaiting_payment");
  });

  it("unauthorized change blocked: an outsider cannot propose or decide", async () => {
    const outsiderUserId = randomUUID();
    await expect(
      ctx.partialPaymentService.proposePartialPayment({
        agreementId,
        proposedAmountMinorUnits: 5_000,
        proposedDate: "2026-03-01",
        actingUserId: outsiderUserId,
      }),
    ).rejects.toThrow(ForbiddenError);

    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    await expect(
      ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: outsiderUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("audits every step of the lifecycle, including the system-attributed expiry", async () => {
    const request = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 5_000,
      proposedDate: "2026-03-01",
      actingUserId: debtorUserId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.partialPaymentService.expireOverdue(new Date("2026-03-02T00:00:00Z"));

    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual(["partial_payment_proposed", "partial_payment_accepted", "partial_payment_expired"]);
    const expiryEvent = ctx.auditRepo.events.find((e) => e.action === "partial_payment_expired");
    expect(expiryEvent?.actorUserId).toBeNull();
    expect(expiryEvent?.actorRole).toBe("scheduler");
  });

  // ---------------------------------------------------------------------------------------------
  // R08 B2 (EC1-001 correction): a payment attempt must be bound back to the SAME agreement and the
  // agreement's own canonical debtor/creditor before it may satisfy a partial-payment request — never
  // merely "succeeded, right amount, right optional installment."
  // ---------------------------------------------------------------------------------------------
  describe("R08 B2 (EC1-001): partial-payment payment-attempt binding", () => {
    async function proposeAndAccept(amountMinorUnits = 5_000): Promise<PartialPaymentRequestRecord> {
      const request = await ctx.partialPaymentService.proposePartialPayment({
        agreementId,
        proposedAmountMinorUnits: amountMinorUnits,
        proposedDate: "2026-03-01",
        actingUserId: debtorUserId,
      });
      await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });
      return request;
    }

    it("PP-R08-B2-1: succeeded payment, same agreement, payer = canonical debtor, recipient = canonical creditor, correct amount -> recordPayment succeeds and persists paymentAttemptId", async () => {
      const request = await proposeAndAccept();
      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `pp-b2-1-${request.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtorProfileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditorProfileId,
        amountMinorUnits: 5_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
      });

      const applied = await ctx.partialPaymentService.recordPayment({
        partialPaymentRequestId: request.id,
        paymentAttemptId: attempt.id,
        actingUserId: debtorUserId,
      });
      expect(applied.status).toBe("applied");
      expect(applied.paymentAttemptId).toBe(attempt.id);
    });

    it("PP-R08-B2-2: cross-agreement payment — attempt says Agreement B, but payer/recipient otherwise match Agreement A's canonical parties (isolates the agreement-id check) -> ValidationError, request remains awaiting_payment, paymentAttemptId stays null, no success audit", async () => {
      const request = await proposeAndAccept();
      const unrelatedAgreementId = randomUUID(); // Agreement B — deliberately NOT a real agreement, only its id differs from Agreement A's
      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `pp-b2-2-${request.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtorProfileId, // Agreement A's actual debtor — deliberately correct
        recipientProfileKind: "personal",
        recipientProfileId: creditorProfileId, // Agreement A's actual creditor — deliberately correct
        amountMinorUnits: 5_000, // deliberately correct
        currency: "USD",
        agreementId: unrelatedAgreementId, // the ONLY mismatch
        providerName: "sandbox",
        initialStatus: "succeeded",
      });

      await expect(
        ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
      ).rejects.toThrow(ValidationError);

      const stillWaiting = await ctx.requests.findById(request.id);
      expect(stillWaiting?.status).toBe("awaiting_payment");
      expect(stillWaiting?.paymentAttemptId).toBeNull();
      expect(ctx.auditRepo.events.some((e) => e.action === "partial_payment_applied")).toBe(false);
    });

    it("PP-R08-B2-3: same agreement but the payer is NOT the agreement's canonical debtor -> ValidationError, zero application mutation, no success audit", async () => {
      const request = await proposeAndAccept();
      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `pp-b2-3-${request.id}`,
        payerProfileKind: "personal",
        payerProfileId: randomUUID(), // NOT this agreement's debtor
        recipientProfileKind: "personal",
        recipientProfileId: creditorProfileId,
        amountMinorUnits: 5_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
      });

      await expect(
        ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
      ).rejects.toThrow(ValidationError);

      const stillWaiting = await ctx.requests.findById(request.id);
      expect(stillWaiting?.status).toBe("awaiting_payment");
      expect(stillWaiting?.paymentAttemptId).toBeNull();
      expect(ctx.auditRepo.events.some((e) => e.action === "partial_payment_applied")).toBe(false);
    });

    it("PP-R08-B2-4: same agreement but the recipient is NOT the agreement's canonical creditor -> ValidationError, zero application mutation, no success audit", async () => {
      const request = await proposeAndAccept();
      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `pp-b2-4-${request.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtorProfileId,
        recipientProfileKind: "personal",
        recipientProfileId: randomUUID(), // NOT this agreement's creditor
        amountMinorUnits: 5_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
      });

      await expect(
        ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
      ).rejects.toThrow(ValidationError);

      const stillWaiting = await ctx.requests.findById(request.id);
      expect(stillWaiting?.status).toBe("awaiting_payment");
      expect(stillWaiting?.paymentAttemptId).toBeNull();
      expect(ctx.auditRepo.events.some((e) => e.action === "partial_payment_applied")).toBe(false);
    });

    it("PP-R08-B2-5: succeeded payment with a null agreementId -> ValidationError, zero application mutation", async () => {
      const request = await proposeAndAccept();
      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `pp-b2-5-${request.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtorProfileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditorProfileId,
        amountMinorUnits: 5_000,
        currency: "USD",
        agreementId: null,
        providerName: "sandbox",
        initialStatus: "succeeded",
      });

      await expect(
        ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
      ).rejects.toThrow(ValidationError);

      const stillWaiting = await ctx.requests.findById(request.id);
      expect(stillWaiting?.status).toBe("awaiting_payment");
      expect(stillWaiting?.paymentAttemptId).toBeNull();
    });

    it("PP-R08-B2-6: pre-existing amount-mismatch check still fires once the payment is otherwise correctly bound to the same agreement and canonical parties", async () => {
      const request = await proposeAndAccept(5_000);
      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `pp-b2-6-${request.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtorProfileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditorProfileId,
        amountMinorUnits: 4_000, // mismatched
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
      });

      await expect(
        ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
      ).rejects.toThrow(ValidationError);

      const stillWaiting = await ctx.requests.findById(request.id);
      expect(stillWaiting?.status).toBe("awaiting_payment");
      expect(stillWaiting?.paymentAttemptId).toBeNull();
    });

    it("PP-R08-B2-7: pre-existing installment-binding check still fires once the payment is otherwise correctly bound to the same agreement and canonical parties", async () => {
      const targetInstallmentId = randomUUID();
      const request = await ctx.partialPaymentService.proposePartialPayment({
        agreementId,
        proposedAmountMinorUnits: 5_000,
        proposedDate: "2026-03-01",
        installmentScheduleItemId: targetInstallmentId,
        actingUserId: debtorUserId,
      });
      await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });

      const attempt = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `pp-b2-7-${request.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtorProfileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditorProfileId,
        amountMinorUnits: 5_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        installmentScheduleItemId: randomUUID(), // a DIFFERENT installment than the request targets
        initialStatus: "succeeded",
      });

      await expect(
        ctx.partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
      ).rejects.toThrow(ValidationError);

      const stillWaiting = await ctx.requests.findById(request.id);
      expect(stillWaiting?.status).toBe("awaiting_payment");
      expect(stillWaiting?.paymentAttemptId).toBeNull();
    });
  });
});
