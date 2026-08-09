import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { CreateDraftInput, DraftTermsInput } from "./agreementService";
import { createTestAgreementService } from "./testFakes";

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

describe("AgreementService", () => {
  let ctx: ReturnType<typeof createTestAgreementService>;

  beforeEach(() => {
    ctx = createTestAgreementService();
  });

  describe("P2P — full lifecycle", () => {
    it("creates, acknowledges, accepts, and signs a personal-to-personal agreement", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      expect(created.agreement.status).toBe("draft");
      expect(ctx.agreementService.relationshipShape(created.agreement)).toBe("P2P");
      expect(created.version.terms.currentPrincipalMinorUnits).toBe(120_000);
      expect(created.version.terms.finalPaymentMinorUnits).toBe(20_000);
      expect(created.schedule).toHaveLength(6); // first payment + 5 installments

      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      let agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_debtor_acknowledgment");

      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_creditor_acceptance");

      await ctx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: creditorUserId,
        decision: "accept",
      });
      agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_signatures");

      await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
      agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_signatures"); // only one party has signed so far

      await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);
      agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("first_payment_pending");

      const version = await ctx.versions.findById(agreement!.currentVersionId!);
      expect(version?.signedAt).not.toBeNull();
      expect(version?.documentHash).toBeTruthy();
    });
  });

  describe("B2C", () => {
    it("supports a business creditor and a personal debtor", async () => {
      const businessOwnerId = randomUUID();
      const businessId = randomUUID();
      const debtorUserId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("business", businessId, businessOwnerId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);

      const created = await ctx.agreementService.createDraft({
        creatorUserId: businessOwnerId,
        creditor: { kind: "business", id: businessId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      expect(ctx.agreementService.relationshipShape(created.agreement)).toBe("B2C");

      await ctx.agreementService.submitDraft(created.agreement.id, businessOwnerId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: businessOwnerId,
        decision: "accept",
      });
      const agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_signatures");
    });
  });

  describe("B2B", () => {
    it("supports two business profiles, authorized via Sprint 4 staff capabilities (not just the owner)", async () => {
      const creditorBusinessId = randomUUID();
      const debtorBusinessId = randomUUID();
      const creditorOwnerId = randomUUID();
      const debtorOwnerId = randomUUID();
      const creditorStaffUserId = randomUUID();
      const debtorStaffUserId = randomUUID();
      ctx.profileOwners.set("business", creditorBusinessId, creditorOwnerId);
      ctx.profileOwners.set("business", debtorBusinessId, debtorOwnerId);
      // Staff members, not the owners — exercises StaffService.requireCapability directly.
      ctx.staffCtx.staffMembers.seed({ businessProfileId: creditorBusinessId, userId: creditorStaffUserId, role: "manager" });
      ctx.staffCtx.staffMembers.seed({ businessProfileId: debtorBusinessId, userId: debtorStaffUserId, role: "receivables_staff" });

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorStaffUserId, // manager has create_agreement
        creditor: { kind: "business", id: creditorBusinessId },
        debtor: { kind: "business", id: debtorBusinessId },
        ...baseTerms(),
      });
      expect(ctx.agreementService.relationshipShape(created.agreement)).toBe("B2B");

      await ctx.agreementService.submitDraft(created.agreement.id, creditorStaffUserId);
      // Debtor-side acknowledgment has no dedicated capability — any active staff member may do it.
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorStaffUserId);

      // A viewer-role staff member lacks approve_agreement.
      const debtorViewerUserId = randomUUID();
      ctx.staffCtx.staffMembers.seed({ businessProfileId: creditorBusinessId, userId: debtorViewerUserId, role: "accountant_viewer" });
      await expect(
        ctx.agreementService.creditorDecide({
          agreementId: created.agreement.id,
          actingUserId: debtorViewerUserId,
          decision: "accept",
        }),
      ).rejects.toThrow(ForbiddenError);

      // The manager who created the draft (create_agreement) also holds approve_agreement by
      // default — a manager is trusted for both, so this succeeds directly rather than falling
      // back to the owner.
      await ctx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: creditorStaffUserId,
        decision: "accept",
      });
      const agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_signatures");
    });
  });

  describe("debtor acknowledgment", () => {
    it("rejects acknowledgment by the creditor (wrong role)", async () => {
      const ctx2 = ctx;
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx2.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx2.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx2.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx2.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await expect(ctx2.agreementService.acknowledgeDebt(created.agreement.id, creditorUserId)).rejects.toThrow(
        ForbiddenError,
      );
    });

    it("rejects acknowledgment before the agreement has been submitted (invalid transition)", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await expect(ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe("creditor acceptance / counter / rejection", () => {
    async function setupAwaitingCreditorAcceptance() {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: debtorUserId, // the debtor initiates this time (either party may — FR-AGR-001)
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      } satisfies CreateDraftInput);
      await ctx.agreementService.submitDraft(created.agreement.id, debtorUserId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      return { created, creditorUserId, debtorUserId };
    }

    it("creditor acceptance: transitions to awaiting_signatures", async () => {
      const { created, creditorUserId } = await setupAwaitingCreditorAcceptance();
      await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
      const agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_signatures");
    });

    it("rejection: returns the agreement to draft and records the reason", async () => {
      const { created, creditorUserId } = await setupAwaitingCreditorAcceptance();
      await ctx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: creditorUserId,
        decision: "reject",
        reason: "Amount is too high.",
      });
      const agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("draft");
      const rejectionEvent = ctx.auditRepo.events.find((e) => e.action === "creditor_rejected");
      expect(rejectionEvent?.newValue).toEqual({ reason: "Amount is too high." });
    });

    it("counter: updates terms/schedule in place and returns the agreement to draft", async () => {
      const { created, creditorUserId } = await setupAwaitingCreditorAcceptance();
      await ctx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: creditorUserId,
        decision: "counter",
        counterTerms: baseTerms({ installmentAmountMinorUnits: 10_000 }),
      });
      const agreement = await ctx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("draft");
      const version = await ctx.versions.findById(agreement!.currentVersionId!);
      expect(version?.terms.installmentAmountMinorUnits).toBe(10_000);
      const schedule = await ctx.scheduleItems.listForVersion(version!.id);
      expect(schedule.length).toBeGreaterThan(6); // smaller installments -> more of them
    });

    it("rejects a decision made by anyone other than the creditor", async () => {
      const { created, debtorUserId } = await setupAwaitingCreditorAcceptance();
      await expect(
        ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: debtorUserId, decision: "accept" }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("unauthorized access", () => {
    it("a user with no relationship to either party cannot view or act on the agreement", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const strangerUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });

      await expect(ctx.agreementService.getAgreement(created.agreement.id, strangerUserId)).rejects.toThrow(ForbiddenError);
      await expect(ctx.agreementService.submitDraft(created.agreement.id, strangerUserId)).rejects.toThrow(ForbiddenError);
      await expect(ctx.agreementService.acknowledgeDebt(created.agreement.id, strangerUserId)).rejects.toThrow(ForbiddenError);
    });

    it("rejects creating a draft when the creator is authorized for neither party", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const strangerUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      await expect(
        ctx.agreementService.createDraft({
          creatorUserId: strangerUserId,
          creditor: { kind: "personal", id: creditorProfileId },
          debtor: { kind: "personal", id: debtorProfileId },
          ...baseTerms(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("immutable signed record", () => {
    it("rejects any attempt to counter/modify terms once the agreement has moved past creditor acceptance", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
      await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
      await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);

      // Status is now first_payment_pending — creditorDecide requires awaiting_creditor_acceptance.
      await expect(
        ctx.agreementService.creditorDecide({
          agreementId: created.agreement.id,
          actingUserId: creditorUserId,
          decision: "counter",
          counterTerms: baseTerms({ installmentAmountMinorUnits: 1 }),
        }),
      ).rejects.toThrow(ValidationError);

      const agreement = await ctx.agreements.findById(created.agreement.id);
      const version = await ctx.versions.findById(agreement!.currentVersionId!);
      expect(version?.signedAt).not.toBeNull();
      expect(version?.terms.installmentAmountMinorUnits).toBe(20_000); // unchanged
    });

    it("rejects signing a version that is already fully signed", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
      await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
      await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);

      await expect(ctx.agreementService.signAgreement(created.agreement.id, creditorUserId)).rejects.toThrow(ValidationError);
    });
  });

  describe("invalid state transitions", () => {
    it("rejects signing before the agreement reaches awaiting_signatures", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await expect(ctx.agreementService.signAgreement(created.agreement.id, creditorUserId)).rejects.toThrow(ValidationError);
    });

    it("rejects submitting a draft twice", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await expect(ctx.agreementService.submitDraft(created.agreement.id, creditorUserId)).rejects.toThrow(ValidationError);
    });

    it("rejects a creditor decision before the agreement reaches awaiting_creditor_acceptance", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await expect(
        ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("required-field validation", () => {
    it("rejects a draft missing a required text field", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      await expect(
        ctx.agreementService.createDraft({
          creatorUserId: creditorUserId,
          creditor: { kind: "personal", id: creditorProfileId },
          debtor: { kind: "personal", id: debtorProfileId },
          ...baseTerms({ disputeProcedure: "" }),
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects creditor and debtor being the same profile", async () => {
      const userId = randomUUID();
      const profileId = randomUUID();
      ctx.profileOwners.set("personal", profileId, userId);
      await expect(
        ctx.agreementService.createDraft({
          creatorUserId: userId,
          creditor: { kind: "personal", id: profileId },
          debtor: { kind: "personal", id: profileId },
          ...baseTerms(),
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
