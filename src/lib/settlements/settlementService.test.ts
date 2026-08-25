import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import type { SettlementTerms } from "./settlementService";
import { createTestSettlementService, grantSettlementStepUp } from "./testFakes";

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

function settlementTerms(overrides: Partial<SettlementTerms> = {}): SettlementTerms {
  return {
    preSettlementBalanceMinorUnits: 100_000,
    settlementAmountMinorUnits: 60_000,
    forgivenAmountMinorUnits: 40_000,
    deadline: "2026-04-01",
    paymentMode: "one_time",
    failureConsequence: "restore_original",
    ...overrides,
  };
}

describe("SettlementService", () => {
  let ctx: ReturnType<typeof createTestSettlementService>;
  let creditorUserId: string;
  let debtorUserId: string;
  let agreementId: string;
  let creditorSessionId: string;

  beforeEach(async () => {
    ctx = createTestSettlementService();
    creditorUserId = randomUUID();
    debtorUserId = randomUUID();
    creditorSessionId = randomUUID();
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

    await ctx.agreementCtx.agreementService.submitDraft(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, debtorUserId);
  });

  it("proposal: the debtor can propose a settlement, capturing every §12-required field", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({
      agreementId,
      ...settlementTerms(),
      actingUserId: debtorUserId,
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.proposingPartyRole).toBe("debtor");
    expect(proposal.preSettlementBalanceMinorUnits).toBe(100_000);
    expect(proposal.settlementAmountMinorUnits).toBe(60_000);
    expect(proposal.forgivenAmountMinorUnits).toBe(40_000);
    expect(proposal.deadline).toBe("2026-04-01");
    expect(proposal.paymentMode).toBe("one_time");
    expect(proposal.failureConsequence).toBe("restore_original");
  });

  it("proposal: the creditor may also propose a settlement, once step-up is granted", async () => {
    await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
    const proposal = await ctx.settlementService.proposeSettlement({
      agreementId,
      ...settlementTerms(),
      actingUserId: creditorUserId,
      actingSessionId: creditorSessionId,
    });
    expect(proposal.proposingPartyRole).toBe("creditor");
  });

  it("rejects terms where forgivenAmountMinorUnits doesn't equal preSettlementBalance minus settlementAmount", async () => {
    await expect(
      ctx.settlementService.proposeSettlement({
        agreementId,
        ...settlementTerms({ forgivenAmountMinorUnits: 1 }),
        actingUserId: debtorUserId,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects restore_stated/forgive_permanently without a stated amount", async () => {
    await expect(
      ctx.settlementService.proposeSettlement({
        agreementId,
        ...settlementTerms({ failureConsequence: "restore_stated" }),
        actingUserId: debtorUserId,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejection: the counterparty can reject a proposed settlement outright", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
    const decided = await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: creditorUserId,
      decision: "reject",
      reason: "Not enough forgiven",
    });
    expect(decided.status).toBe("rejected");
    expect(decided.rejectedReason).toBe("Not enough forgiven");
  });

  it("the proposer cannot decide their own settlement proposal", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
    await expect(
      ctx.settlementService.decideSettlement({ settlementProposalId: proposal.id, actingUserId: debtorUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("counter: the counterparty can counter with different terms, mutating the same proposal and flipping whose turn it is", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
    await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
    const countered = await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: creditorUserId,
      actingSessionId: creditorSessionId,
      decision: "counter",
      counterTerms: settlementTerms({ settlementAmountMinorUnits: 70_000, forgivenAmountMinorUnits: 30_000 }),
    });
    expect(countered.id).toBe(proposal.id);
    expect(countered.status).toBe("proposed");
    expect(countered.proposingPartyRole).toBe("creditor");
    expect(countered.settlementAmountMinorUnits).toBe(70_000);

    const accepted = await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: debtorUserId,
      decision: "accept",
    });
    expect(accepted.status).toBe("awaiting_payment");
  });

  describe("creditor step-up gating (Product Owner review pass: widened from 'creditor accepts' alone to every creditor action that fixes binding-capable terms)", () => {
    it("blocks creditor acceptance without a fresh step-up", async () => {
      const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
      await expect(
        ctx.settlementService.decideSettlement({
          settlementProposalId: proposal.id,
          actingUserId: creditorUserId,
          actingSessionId: creditorSessionId,
          decision: "accept",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("allows creditor acceptance once a fresh step-up is granted", async () => {
      const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
      await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
      const accepted = await ctx.settlementService.decideSettlement({
        settlementProposalId: proposal.id,
        actingUserId: creditorUserId,
        actingSessionId: creditorSessionId,
        decision: "accept",
      });
      expect(accepted.status).toBe("awaiting_payment");
      expect(accepted.acceptedAt).toBeTruthy();
    });

    it("does not require step-up for the debtor's own acceptance of a (step-up-gated) creditor proposal", async () => {
      await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
      const proposal = await ctx.settlementService.proposeSettlement({
        agreementId,
        ...settlementTerms(),
        actingUserId: creditorUserId,
        actingSessionId: creditorSessionId,
      });
      const accepted = await ctx.settlementService.decideSettlement({
        settlementProposalId: proposal.id,
        actingUserId: debtorUserId,
        decision: "accept",
      });
      expect(accepted.status).toBe("awaiting_payment");
    });

    it("blocks a creditor-originated proposal without a fresh step-up — the gap this review pass closed: a debtor could otherwise accept unstepped-up creditor-set forgiveness terms as-is", async () => {
      await expect(
        ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: creditorUserId }),
      ).rejects.toThrow(ValidationError);
      await expect(
        ctx.settlementService.proposeSettlement({
          agreementId,
          ...settlementTerms(),
          actingUserId: creditorUserId,
          actingSessionId: creditorSessionId,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("blocks a creditor counteroffer without a fresh step-up — the same gap, for the counter path", async () => {
      const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
      await expect(
        ctx.settlementService.decideSettlement({
          settlementProposalId: proposal.id,
          actingUserId: creditorUserId,
          actingSessionId: creditorSessionId,
          decision: "counter",
          counterTerms: settlementTerms({ settlementAmountMinorUnits: 70_000, forgivenAmountMinorUnits: 30_000 }),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("does not require step-up for the debtor's own proposal or counter, and re-gates the creditor on the resulting accept", async () => {
      await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
      const proposal = await ctx.settlementService.proposeSettlement({
        agreementId,
        ...settlementTerms(),
        actingUserId: creditorUserId,
        actingSessionId: creditorSessionId,
      });

      // Debtor counters — no session/step-up needed at all, since the debtor side is never gated.
      const countered = await ctx.settlementService.decideSettlement({
        settlementProposalId: proposal.id,
        actingUserId: debtorUserId,
        decision: "counter",
        counterTerms: settlementTerms({ settlementAmountMinorUnits: 50_000, forgivenAmountMinorUnits: 50_000 }),
      });
      expect(countered.proposingPartyRole).toBe("debtor");

      // Accepting is gated independently of proposing — omitting actingSessionId here proves the
      // creditor's earlier step-up (used to propose) isn't implicitly reused for a later, separate
      // binding action; each gated action must supply its own fresh session/step-up.
      await expect(
        ctx.settlementService.decideSettlement({ settlementProposalId: proposal.id, actingUserId: creditorUserId, decision: "accept" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  it("unauthorized change blocked: a business-staff creditor without approve_settlement cannot decide, but a manager needs it granted explicitly (not a default manager capability)", async () => {
    const creditorBusinessId = randomUUID();
    const creditorOwnerId = randomUUID();
    const debtorProfileId = randomUUID();
    const debtorUserId2 = randomUUID();
    const creditorViewerUserId = randomUUID();
    ctx.agreementCtx.profileOwners.set("business", creditorBusinessId, creditorOwnerId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId2);
    ctx.agreementCtx.staffCtx.staffMembers.seed({ businessProfileId: creditorBusinessId, userId: creditorViewerUserId, role: "accountant_viewer" });

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

    const proposal = await ctx.settlementService.proposeSettlement({ agreementId: b2c.agreement.id, ...settlementTerms(), actingUserId: debtorUserId2 });

    await expect(
      ctx.settlementService.decideSettlement({ settlementProposalId: proposal.id, actingUserId: creditorViewerUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);

    // The business owner always bypasses capability checks (Sprint 5/14 precedent) — still needs step-up.
    await grantSettlementStepUp(ctx.mfaCtx, creditorOwnerId, creditorSessionId);
    const decided = await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: creditorOwnerId,
      actingSessionId: creditorSessionId,
      decision: "accept",
    });
    expect(decided.status).toBe("awaiting_payment");
  });

  it("unauthorized change blocked: a business-staff creditor without approve_settlement cannot propose either — closes the capability bypass a creditor-authored proposal + debtor accept would otherwise leave open", async () => {
    const creditorBusinessId = randomUUID();
    const creditorOwnerId = randomUUID();
    const debtorProfileId = randomUUID();
    const debtorUserId2 = randomUUID();
    const creditorManagerUserId = randomUUID();
    ctx.agreementCtx.profileOwners.set("business", creditorBusinessId, creditorOwnerId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId2);
    // approve_settlement is a HIGH_RISK_CAPABILITY, not in a manager's default set (unlike
    // approve_agreement/approve_partial_payment) — a manager needs it granted explicitly.
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

    const managerSessionId = randomUUID();
    await grantSettlementStepUp(ctx.mfaCtx, creditorManagerUserId, managerSessionId);
    await expect(
      ctx.settlementService.proposeSettlement({
        agreementId: b2c.agreement.id,
        ...settlementTerms(),
        actingUserId: creditorManagerUserId,
        actingSessionId: managerSessionId,
      }),
    ).rejects.toThrow(ForbiddenError);

    // The business owner always bypasses capability checks (Sprint 5/14 precedent) — still needs their own step-up.
    const ownerSessionId = randomUUID();
    await grantSettlementStepUp(ctx.mfaCtx, creditorOwnerId, ownerSessionId);
    const proposal = await ctx.settlementService.proposeSettlement({
      agreementId: b2c.agreement.id,
      ...settlementTerms(),
      actingUserId: creditorOwnerId,
      actingSessionId: ownerSessionId,
    });
    expect(proposal.proposingPartyRole).toBe("creditor");
  });

  it("recordSettlementPayment: a full one-time payment completes the settlement and marks the agreement SETTLED_IN_FULL, never PAID_IN_FULL", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
    await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
    await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: creditorUserId,
      actingSessionId: creditorSessionId,
      decision: "accept",
    });

    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `settlement-${proposal.id}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 60_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
    });

    const completed = await ctx.settlementService.recordSettlementPayment({
      settlementProposalId: proposal.id,
      paymentAttemptId: attempt.id,
      actingUserId: debtorUserId,
    });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();

    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.status).toBe("settled_in_full");
    expect(agreement?.status).not.toBe("paid_in_full");
  });

  it("recordSettlementPayment: a scheduled settlement completes only once the linked total reaches the full settlement amount", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({
      agreementId,
      ...settlementTerms({ paymentMode: "scheduled" }),
      actingUserId: debtorUserId,
    });
    await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
    await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: creditorUserId,
      actingSessionId: creditorSessionId,
      decision: "accept",
    });

    const first = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `settlement-1-${proposal.id}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 30_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
    });
    const afterFirst = await ctx.settlementService.recordSettlementPayment({
      settlementProposalId: proposal.id,
      paymentAttemptId: first.id,
      actingUserId: debtorUserId,
    });
    expect(afterFirst.status).toBe("awaiting_payment");

    const second = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `settlement-2-${proposal.id}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 30_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
    });
    const afterSecond = await ctx.settlementService.recordSettlementPayment({
      settlementProposalId: proposal.id,
      paymentAttemptId: second.id,
      actingUserId: debtorUserId,
    });
    expect(afterSecond.status).toBe("completed");
    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.status).toBe("settled_in_full");
  });

  it("recordSettlementPayment: a one-time payment for less than the full amount is rejected", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
    await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
    await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: creditorUserId,
      actingSessionId: creditorSessionId,
      decision: "accept",
    });
    const attempt = await ctx.paymentCtx.payments.insertPending({
      idempotencyKey: `settlement-${proposal.id}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 10_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
    });
    await expect(
      ctx.settlementService.recordSettlementPayment({ settlementProposalId: proposal.id, paymentAttemptId: attempt.id, actingUserId: debtorUserId }),
    ).rejects.toThrow(ValidationError);
  });

  describe("failed-settlement consequences (Tests cover all consequences)", () => {
    async function proposeAcceptedSettlement(overrides: Partial<SettlementTerms>) {
      const proposal = await ctx.settlementService.proposeSettlement({
        agreementId,
        ...settlementTerms(overrides),
        actingUserId: debtorUserId,
      });
      await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
      await ctx.settlementService.decideSettlement({
        settlementProposalId: proposal.id,
        actingUserId: creditorUserId,
        actingSessionId: creditorSessionId,
        decision: "accept",
      });
      return proposal;
    }

    it("restore_original: restores the pre-settlement balance minus whatever partial settlement payments already cleared", async () => {
      const proposal = await proposeAcceptedSettlement({ failureConsequence: "restore_original", paymentMode: "scheduled" });
      const partial = await ctx.paymentCtx.payments.insertPending({
        idempotencyKey: `settlement-partial-${proposal.id}`,
        payerProfileKind: "personal",
        payerProfileId: randomUUID(),
        recipientProfileKind: "personal",
        recipientProfileId: randomUUID(),
        amountMinorUnits: 20_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
      });
      await ctx.settlementService.recordSettlementPayment({ settlementProposalId: proposal.id, paymentAttemptId: partial.id, actingUserId: debtorUserId });

      const result = await ctx.settlementService.expireOverdueSettlements(new Date("2026-04-02T00:00:00Z"));
      expect(result.resolved).toBe(1);
      const resolved = await ctx.proposals.findById(proposal.id);
      expect(resolved?.status).toBe("failure_consequence_applied");
      expect(resolved?.resolvedConsequence).toBe("restore_original");
      expect(resolved?.resolvedRestoredBalanceMinorUnits).toBe(100_000 - 20_000);
      expect(resolved?.resolvedForgivenAmountMinorUnits).toBeNull();
    });

    it("restore_stated: restores exactly the specifically stated balance chosen at proposal time", async () => {
      const proposal = await proposeAcceptedSettlement({ failureConsequence: "restore_stated", failureConsequenceStatedAmountMinorUnits: 75_000 });
      await ctx.settlementService.expireOverdueSettlements(new Date("2026-04-02T00:00:00Z"));
      const resolved = await ctx.proposals.findById(proposal.id);
      expect(resolved?.resolvedConsequence).toBe("restore_stated");
      expect(resolved?.resolvedRestoredBalanceMinorUnits).toBe(75_000);
      expect(resolved?.resolvedForgivenAmountMinorUnits).toBeNull();
    });

    it("forgive_permanently: permanently forgives exactly the stated amount chosen at proposal time", async () => {
      const proposal = await proposeAcceptedSettlement({ failureConsequence: "forgive_permanently", failureConsequenceStatedAmountMinorUnits: 15_000 });
      await ctx.settlementService.expireOverdueSettlements(new Date("2026-04-02T00:00:00Z"));
      const resolved = await ctx.proposals.findById(proposal.id);
      expect(resolved?.resolvedConsequence).toBe("forgive_permanently");
      expect(resolved?.resolvedForgivenAmountMinorUnits).toBe(15_000);
      expect(resolved?.resolvedRestoredBalanceMinorUnits).toBeNull();
    });

    it("prior_agreement_controls: declarative only — no numeric resolution, and the agreement's own status is never touched by a failed settlement", async () => {
      const proposal = await proposeAcceptedSettlement({ failureConsequence: "prior_agreement_controls" });
      await ctx.settlementService.expireOverdueSettlements(new Date("2026-04-02T00:00:00Z"));
      const resolved = await ctx.proposals.findById(proposal.id);
      expect(resolved?.resolvedConsequence).toBe("prior_agreement_controls");
      expect(resolved?.resolvedRestoredBalanceMinorUnits).toBeNull();
      expect(resolved?.resolvedForgivenAmountMinorUnits).toBeNull();

      const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
      expect(agreement?.status).toBe("first_payment_pending");
    });

    it("the consequence applied always matches the one chosen at proposal time, never substituted", async () => {
      const proposal = await proposeAcceptedSettlement({ failureConsequence: "forgive_permanently", failureConsequenceStatedAmountMinorUnits: 5_000 });
      await ctx.settlementService.expireOverdueSettlements(new Date("2026-04-02T00:00:00Z"));
      const resolved = await ctx.proposals.findById(proposal.id);
      expect(resolved?.resolvedConsequence).toBe(resolved?.failureConsequence);
    });

    it("leaves a not-yet-due awaiting-payment settlement untouched", async () => {
      const proposal = await proposeAcceptedSettlement({ deadline: "2026-05-01" });
      const result = await ctx.settlementService.expireOverdueSettlements(new Date("2026-04-02T00:00:00Z"));
      expect(result.resolved).toBe(0);
      const stillWaiting = await ctx.proposals.findById(proposal.id);
      expect(stillWaiting?.status).toBe("awaiting_payment");
    });
  });

  it("audits every step of the lifecycle, including the system-attributed failure-consequence resolution", async () => {
    const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(), actingUserId: debtorUserId });
    await grantSettlementStepUp(ctx.mfaCtx, creditorUserId, creditorSessionId);
    await ctx.settlementService.decideSettlement({
      settlementProposalId: proposal.id,
      actingUserId: creditorUserId,
      actingSessionId: creditorSessionId,
      decision: "accept",
    });
    await ctx.settlementService.expireOverdueSettlements(new Date("2026-04-02T00:00:00Z"));

    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual([
      "settlement_proposed",
      "settlement_accepted",
      "settlement_failure_consequence_applied",
    ]);
    const resolutionEvent = ctx.auditRepo.events.find((e) => e.action === "settlement_failure_consequence_applied");
    expect(resolutionEvent?.actorUserId).toBeNull();
    expect(resolutionEvent?.actorRole).toBe("scheduler");
  });
});
