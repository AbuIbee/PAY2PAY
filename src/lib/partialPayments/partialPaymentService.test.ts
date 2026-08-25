import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
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
  let agreementId: string;
  let originalVersionId: string;

  beforeEach(async () => {
    ctx = createTestPartialPaymentService();
    creditorUserId = randomUUID();
    debtorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);

    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    agreementId = created.agreement.id;
    originalVersionId = created.version.id;

    await ctx.agreementCtx.agreementService.submitDraft(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, debtorUserId);
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
      creatorUserId: creditorOwnerId,
      creditor: { kind: "business", id: creditorBusinessId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    await ctx.agreementCtx.agreementService.submitDraft(b2c.agreement.id, creditorOwnerId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(b2c.agreement.id, debtorUserId2);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId: b2c.agreement.id, actingUserId: creditorOwnerId, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(b2c.agreement.id, creditorOwnerId);
    await ctx.agreementCtx.agreementService.signAgreement(b2c.agreement.id, debtorUserId2);

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
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
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

    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `pp-${request.id}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
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
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
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
});
