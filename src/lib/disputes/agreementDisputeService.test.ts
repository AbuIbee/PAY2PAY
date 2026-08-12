import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createTestAgreementDisputeService } from "./testFakes";

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: "2026-02-01",
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

describe("AgreementDisputeService", () => {
  let ctx: ReturnType<typeof createTestAgreementDisputeService>;
  let creditorUserId: string;
  let debtorUserId: string;
  let agreementId: string;

  beforeEach(async () => {
    ctx = createTestAgreementDisputeService();
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

    await ctx.agreementCtx.agreementService.submitDraft(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, debtorUserId);
  });

  let nextEvidenceByte = 1;

  async function uploadEvidence(actingUserId: string): Promise<string> {
    const record = await ctx.evidenceService.uploadEvidence({
      agreementId,
      actingUserId,
      documentType: "invoice",
      description: "Original invoice",
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      content: new Uint8Array([nextEvidenceByte++, 2, 3, 4]),
      visibility: "shared",
      sharedWithWitnesses: false,
      ipAddress: null,
      deviceInfo: null,
    });
    return record.id;
  }

  describe("agreement dispute", () => {
    it("opening: either party can open a dispute, capturing category/explanation/status", async () => {
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "incorrect_amount",
        explanation: "The installment amount does not match what we agreed.",
        actingUserId: debtorUserId,
      });
      expect(dispute.status).toBe("opened");
      expect(dispute.category).toBe("incorrect_amount");
      expect(dispute.raisedByRole).toBe("debtor");
      expect(dispute.raisedByUserId).toBe(debtorUserId);
    });

    it("responding: the counterparty can respond, moving status to under_review", async () => {
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "debt_does_not_exist",
        explanation: "I never agreed to this debt.",
        actingUserId: debtorUserId,
      });
      const responded = await ctx.agreementDisputeService.respondToDispute({
        disputeId: dispute.id,
        response: "Here is the signed agreement proving the debt exists.",
        actingUserId: creditorUserId,
      });
      expect(responded.status).toBe("under_review");
      expect(responded.response).toBe("Here is the signed agreement proving the debt exists.");
      expect(responded.respondedByUserId).toBe(creditorUserId);
    });

    it("the party who raised the dispute cannot respond to their own dispute", async () => {
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "other",
        explanation: "x",
        actingUserId: debtorUserId,
      });
      await expect(
        ctx.agreementDisputeService.respondToDispute({ disputeId: dispute.id, response: "y", actingUserId: debtorUserId }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("resolveNoChange then close: resolves without balance/schedule change, closes on a separate call", async () => {
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "administration_challenged",
        explanation: "x",
        actingUserId: debtorUserId,
      });
      await ctx.agreementDisputeService.respondToDispute({ disputeId: dispute.id, response: "y", actingUserId: creditorUserId });
      const resolved = await ctx.agreementDisputeService.resolveNoChange({
        disputeId: dispute.id,
        actingUserId: creditorUserId,
        resolutionNotes: "Reviewed and found administration was correct.",
      });
      expect(resolved.status).toBe("resolved_no_change");
      expect(resolved.resolutionNotes).toBe("Reviewed and found administration was correct.");

      const closed = await ctx.agreementDisputeService.closeDispute({ disputeId: dispute.id, actingUserId: debtorUserId });
      expect(closed.status).toBe("closed");
      expect(closed.closedAt).toBeTruthy();
    });

    it("resolveWithAmendment: hands off to AmendmentService and closes once the amendment applies", async () => {
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "incorrect_amount",
        explanation: "x",
        actingUserId: debtorUserId,
      });
      const resolved = await ctx.agreementDisputeService.resolveWithAmendment({
        disputeId: dispute.id,
        actingUserId: debtorUserId,
        changeType: "revised_schedule",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      });
      expect(resolved.status).toBe("resolved_with_amendment");
      expect(resolved.resultingAmendmentId).toBeTruthy();

      // Not yet applied — syncing is a no-op.
      const stillOpen = await ctx.agreementDisputeService.syncAmendmentProgress({ disputeId: dispute.id, actingUserId: debtorUserId });
      expect(stillOpen.status).toBe("resolved_with_amendment");

      await ctx.amendmentService.decideAmendment({ amendmentId: resolved.resultingAmendmentId!, actingUserId: creditorUserId, decision: "accept" });
      await ctx.amendmentService.signAmendment({ amendmentId: resolved.resultingAmendmentId!, actingUserId: creditorUserId });
      await ctx.amendmentService.signAmendment({ amendmentId: resolved.resultingAmendmentId!, actingUserId: debtorUserId });

      const closed = await ctx.agreementDisputeService.syncAmendmentProgress({ disputeId: dispute.id, actingUserId: debtorUserId });
      expect(closed.status).toBe("closed");
    });

    it("never sets a terminal state declaring a party legally correct (FR-DISP-004) — resolution fields are free-text, not a fault determination", async () => {
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "evidence_challenged",
        explanation: "x",
        actingUserId: debtorUserId,
      });
      const resolved = await ctx.agreementDisputeService.resolveNoChange({ disputeId: dispute.id, actingUserId: creditorUserId });
      expect(Object.keys(resolved)).not.toContain("faultParty");
      expect(Object.keys(resolved)).not.toContain("legallyCorrectParty");
    });
  });

  describe("permissions", () => {
    it("an outsider cannot open or respond to a dispute", async () => {
      const outsiderUserId = randomUUID();
      await expect(
        ctx.agreementDisputeService.openDispute({ agreementId, category: "other", explanation: "x", actingUserId: outsiderUserId }),
      ).rejects.toThrow(ForbiddenError);

      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "other",
        explanation: "x",
        actingUserId: debtorUserId,
      });
      await expect(
        ctx.agreementDisputeService.respondToDispute({ disputeId: dispute.id, response: "y", actingUserId: outsiderUserId }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("restricting/lifting a restriction requires Platform Admin/Owner, never a party", async () => {
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "other",
        explanation: "x",
        actingUserId: debtorUserId,
      });
      await ctx.agreementDisputeService.respondToDispute({ disputeId: dispute.id, response: "y", actingUserId: creditorUserId });

      await expect(
        ctx.agreementDisputeService.restrictDispute({ disputeId: dispute.id, actingUserId: creditorUserId, actingRole: "member", reason: "z" }),
      ).rejects.toThrow(ForbiddenError);

      const restricted = await ctx.agreementDisputeService.restrictDispute({
        disputeId: dispute.id,
        actingUserId: randomUUID(),
        actingRole: "platform_admin",
        reason: "Under investigation for suspected fraud.",
      });
      expect(restricted.status).toBe("restricted");
      expect(restricted.restrictedReason).toBe("Under investigation for suspected fraud.");

      await expect(
        ctx.agreementDisputeService.liftRestriction({ disputeId: dispute.id, actingUserId: creditorUserId, actingRole: "member", target: "under_review" }),
      ).rejects.toThrow(ForbiddenError);

      const lifted = await ctx.agreementDisputeService.liftRestriction({
        disputeId: dispute.id,
        actingUserId: randomUUID(),
        actingRole: "platform_admin",
        target: "under_review",
      });
      expect(lifted.status).toBe("under_review");
    });
  });

  describe("evidence", () => {
    it("openDispute flags provided evidence for dispute; respondToDispute can flag additional evidence", async () => {
      const debtorEvidenceId = await uploadEvidence(debtorUserId);
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "evidence_challenged",
        explanation: "x",
        evidenceIds: [debtorEvidenceId],
        actingUserId: debtorUserId,
      });
      expect(dispute).toBeDefined();

      const creditorEvidenceId = await uploadEvidence(creditorUserId);
      await ctx.agreementDisputeService.respondToDispute({
        disputeId: dispute.id,
        response: "y",
        evidenceIds: [creditorEvidenceId],
        actingUserId: creditorUserId,
      });

      const flagged = (await ctx.evidenceService.listEvidence(agreementId, creditorUserId)).filter((e) => e.disputeFlag);
      expect(flagged.map((e) => e.id).sort()).toEqual([debtorEvidenceId, creditorEvidenceId].sort());
    });

    it("exportEvidencePackage bundles the dispute record with only its currently-flagged evidence", async () => {
      const flaggedId = await uploadEvidence(debtorUserId);
      const unflaggedId = await uploadEvidence(debtorUserId);
      const dispute = await ctx.agreementDisputeService.openDispute({
        agreementId,
        category: "evidence_challenged",
        explanation: "x",
        evidenceIds: [flaggedId],
        actingUserId: debtorUserId,
      });

      const bundle = await ctx.agreementDisputeService.exportEvidencePackage(dispute.id, debtorUserId);
      expect(bundle.dispute.id).toBe(dispute.id);
      expect(bundle.evidence.map((e) => e.id)).toEqual([flaggedId]);
      expect(bundle.evidence.map((e) => e.id)).not.toContain(unflaggedId);
    });
  });

  it("audits every step of the no-change lifecycle", async () => {
    const dispute = await ctx.agreementDisputeService.openDispute({
      agreementId,
      category: "other",
      explanation: "x",
      actingUserId: debtorUserId,
    });
    await ctx.agreementDisputeService.respondToDispute({ disputeId: dispute.id, response: "y", actingUserId: creditorUserId });
    await ctx.agreementDisputeService.resolveNoChange({ disputeId: dispute.id, actingUserId: creditorUserId });
    await ctx.agreementDisputeService.closeDispute({ disputeId: dispute.id, actingUserId: debtorUserId });

    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual([
      "agreement_dispute_opened",
      "agreement_dispute_responded",
      "agreement_dispute_resolved_no_change",
      "agreement_dispute_closed",
    ]);
  });

  it("rejects deciding a dispute that is no longer in an actionable state", async () => {
    const dispute = await ctx.agreementDisputeService.openDispute({
      agreementId,
      category: "other",
      explanation: "x",
      actingUserId: debtorUserId,
    });
    await ctx.agreementDisputeService.respondToDispute({ disputeId: dispute.id, response: "y", actingUserId: creditorUserId });
    await ctx.agreementDisputeService.resolveNoChange({ disputeId: dispute.id, actingUserId: creditorUserId });
    await expect(
      ctx.agreementDisputeService.respondToDispute({ disputeId: dispute.id, response: "z", actingUserId: creditorUserId }),
    ).rejects.toThrow(ValidationError);
  });
});
