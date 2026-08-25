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

  /**
   * Agreement workflow remediation (Problem 2 — a UAT-discovered live defect: an unsigned agreement's
   * proposed first payment date can silently pass while parties negotiate/verify, then get signed
   * anyway with an already-stale schedule). Covers the signing guard and its required resolution
   * path, reviseFirstPaymentDate.
   */
  describe("Problem 2 — expired first payment date", () => {
    async function setUpAwaitingSignatures(overrides: Partial<DraftTermsInput> = {}) {
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
        ...baseTerms(overrides),
      });
      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
      return { agreementId: created.agreement.id, creditorUserId, debtorUserId };
    }

    it("blocks the first signature attempt once the proposed first payment date has already passed", async () => {
      const { agreementId, creditorUserId } = await setUpAwaitingSignatures({ firstPaymentDate: "2020-01-01" });
      await expect(ctx.agreementService.signAgreement(agreementId, creditorUserId)).rejects.toThrow(ValidationError);
      const agreement = await ctx.agreements.findById(agreementId);
      expect(agreement?.status).toBe("awaiting_signatures"); // never advanced to signed
    });

    it("also blocks the completing (second) signature if the date lapses between the two signatures", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await setUpAwaitingSignatures();
      await ctx.agreementService.signAgreement(agreementId, creditorUserId); // valid at the time
      // Simulate real-world delay: the version's own terms are mutated directly, exactly as if enough
      // wall-clock time had passed for the proposed date to lapse before the debtor got to sign.
      const agreement = await ctx.agreements.findById(agreementId);
      const version = await ctx.versions.findById(agreement!.currentVersionId!);
      version!.terms = { ...version!.terms, firstPaymentDate: "2020-01-01" };

      await expect(ctx.agreementService.signAgreement(agreementId, debtorUserId)).rejects.toThrow(ValidationError);
      const stillPending = await ctx.agreements.findById(agreementId);
      expect(stillPending?.status).toBe("awaiting_signatures"); // never reached first_payment_pending
    });

    it("does not block signing when the proposed first payment date is today or in the future", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await setUpAwaitingSignatures();
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      await ctx.agreementService.signAgreement(agreementId, debtorUserId);
      const agreement = await ctx.agreements.findById(agreementId);
      expect(agreement?.status).toBe("first_payment_pending");
    });

    it("reviseFirstPaymentDate: either party can propose a new date, recomputing the schedule and unblocking signing", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await setUpAwaitingSignatures({ firstPaymentDate: "2020-01-01" });
      const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const result = await ctx.agreementService.reviseFirstPaymentDate({
        agreementId,
        actingUserId: debtorUserId, // the debtor (not just the creditor) may propose the revision
        newFirstPaymentDate: futureDate,
      });
      expect(result.version.terms.firstPaymentDate).toBe(futureDate);
      expect(result.schedule[0]?.dueDate).toBe(futureDate);

      // Now unblocked — both parties can sign normally.
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      await ctx.agreementService.signAgreement(agreementId, debtorUserId);
      const agreement = await ctx.agreements.findById(agreementId);
      expect(agreement?.status).toBe("first_payment_pending");
    });

    it("reviseFirstPaymentDate: invalidates an already-recorded partial signature, since it was captured against the old (stale) terms", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await setUpAwaitingSignatures();
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);

      // Simulate the date lapsing before the debtor signs (see the earlier test for the same setup).
      const agreement = await ctx.agreements.findById(agreementId);
      const version = await ctx.versions.findById(agreement!.currentVersionId!);
      version!.terms = { ...version!.terms, firstPaymentDate: "2020-01-01" };

      const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await ctx.agreementService.reviseFirstPaymentDate({ agreementId, actingUserId: debtorUserId, newFirstPaymentDate: futureDate });

      const revisedVersion = await ctx.versions.findById(agreement!.currentVersionId!);
      expect(revisedVersion?.creditorSignedAt).toBeNull();
      expect(revisedVersion?.debtorSignedAt).toBeNull();

      // Creditor must sign again under the new terms.
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      await ctx.agreementService.signAgreement(agreementId, debtorUserId);
      const finalAgreement = await ctx.agreements.findById(agreementId);
      expect(finalAgreement?.status).toBe("first_payment_pending");
    });

    it("reviseFirstPaymentDate: rejects a new date that is itself still in the past", async () => {
      const { agreementId, creditorUserId } = await setUpAwaitingSignatures({ firstPaymentDate: "2020-01-01" });
      await expect(
        ctx.agreementService.reviseFirstPaymentDate({ agreementId, actingUserId: creditorUserId, newFirstPaymentDate: "2020-06-01" }),
      ).rejects.toThrow(ValidationError);
    });

    it("reviseFirstPaymentDate: rejects a stranger with no relationship to either party", async () => {
      const { agreementId } = await setUpAwaitingSignatures({ firstPaymentDate: "2020-01-01" });
      const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await expect(
        ctx.agreementService.reviseFirstPaymentDate({ agreementId, actingUserId: randomUUID(), newFirstPaymentDate: futureDate }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("reviseFirstPaymentDate: rejects once the agreement is fully signed (immutable past that point)", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await setUpAwaitingSignatures();
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      await ctx.agreementService.signAgreement(agreementId, debtorUserId);
      const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await expect(
        ctx.agreementService.reviseFirstPaymentDate({ agreementId, actingUserId: creditorUserId, newFirstPaymentDate: futureDate }),
      ).rejects.toThrow(ValidationError);
    });

    it("every schedule revision is audited with the before/after dates", async () => {
      const { agreementId, creditorUserId } = await setUpAwaitingSignatures({ firstPaymentDate: "2020-01-01" });
      const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await ctx.agreementService.reviseFirstPaymentDate({ agreementId, actingUserId: creditorUserId, newFirstPaymentDate: futureDate });

      const revisionEvent = ctx.auditRepo.events.find(
        (e) => e.agreementId === agreementId && e.action === "agreement_first_payment_date_revised",
      );
      expect(revisionEvent).toBeTruthy();
      expect(revisionEvent?.newValue).toMatchObject({ previousFirstPaymentDate: "2020-01-01", newFirstPaymentDate: futureDate });
    });
  });

  /**
   * PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): before this, none of
   * submitDraft/acknowledgeDebt/creditorDecide ever called NotificationService.notify at all,
   * despite two of the four PRSprint 13 event types (`agreement_action_required`/`agreement_decided`)
   * existing for exactly this purpose. Uses its own local `ctx` (constructed with a real
   * NotificationService) rather than the outer `beforeEach`'s, which deliberately omits it.
   */
  describe("PRSprint 13: notification wiring", () => {
    async function setupNotifiedAgreement() {
      const { createTestNotificationService } = await import("@/lib/notify/testFakes");
      const notifyCtx = createTestNotificationService();
      const localCtx = createTestAgreementService(undefined, notifyCtx.notificationService);
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      localCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      localCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      notifyCtx.contacts.set(creditorUserId, "creditor@example.com");
      notifyCtx.contacts.set(debtorUserId, "debtor@example.com");
      const created = await localCtx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      return { localCtx, notifyCtx, created, creditorUserId, debtorUserId };
    }

    it("submitDraft notifies the debtor (recipient resolution: creditor → debtor)", async () => {
      const { localCtx, notifyCtx, created, debtorUserId } = await setupNotifiedAgreement();
      await localCtx.agreementService.submitDraft(created.agreement.id, created.agreement.createdByUserId);
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtorUserId);
      expect(debtorNotifications.some((n) => n.notificationType === "agreement_action_required")).toBe(true);
      expect(debtorNotifications.every((n) => n.relatedAgreementId === created.agreement.id)).toBe(true);
    });

    it("acknowledgeDebt notifies the creditor (recipient resolution: debtor → creditor)", async () => {
      const { localCtx, notifyCtx, created, creditorUserId, debtorUserId } = await setupNotifiedAgreement();
      await localCtx.agreementService.submitDraft(created.agreement.id, created.agreement.createdByUserId);
      await localCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      const creditorNotifications = await notifyCtx.notificationService.listForUser(creditorUserId);
      expect(creditorNotifications.some((n) => n.notificationType === "agreement_action_required")).toBe(true);
    });

    it("creditorDecide(accept) notifies the debtor with decision=accepted", async () => {
      const { localCtx, notifyCtx, created, creditorUserId, debtorUserId } = await setupNotifiedAgreement();
      await localCtx.agreementService.submitDraft(created.agreement.id, created.agreement.createdByUserId);
      await localCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await localCtx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtorUserId);
      const decided = debtorNotifications.find((n) => n.notificationType === "agreement_decided");
      expect(decided?.payload).toMatchObject({ decision: "accepted" });
    });

    it("creditorDecide(reject) notifies the debtor with decision=rejected", async () => {
      const { localCtx, notifyCtx, created, creditorUserId, debtorUserId } = await setupNotifiedAgreement();
      await localCtx.agreementService.submitDraft(created.agreement.id, created.agreement.createdByUserId);
      await localCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await localCtx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "reject", reason: "no" });
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtorUserId);
      const decided = debtorNotifications.find((n) => n.notificationType === "agreement_decided");
      expect(decided?.payload).toMatchObject({ decision: "rejected" });
    });

    it("creditorDecide(counter) notifies the debtor to review new terms, and a SECOND counter round after resubmission produces a distinct, non-deduplicated notification", async () => {
      const { localCtx, notifyCtx, created, creditorUserId, debtorUserId } = await setupNotifiedAgreement();
      await localCtx.agreementService.submitDraft(created.agreement.id, created.agreement.createdByUserId);
      await localCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await localCtx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: creditorUserId,
        decision: "counter",
        counterTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      });
      // Second round: debtor resubmits, acknowledges again is N/A (debtor already the one who must
      // review) — instead simulate the natural next round via submitDraft → acknowledgeDebt → counter again.
      await localCtx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await localCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await localCtx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: creditorUserId,
        decision: "counter",
        counterTerms: baseTerms({ installmentAmountMinorUnits: 10_000 }),
      });
      const debtorNotifications = (await notifyCtx.notificationService.listForUser(debtorUserId)).filter(
        (n) => n.notificationType === "agreement_action_required" && n.channel === "email",
      );
      // Both counter rounds must be represented (one email-channel row each) — PRSprint 13's own
      // "do not over-deduplicate legitimate distinct events" requirement.
      const reviewCounterNotifications = debtorNotifications.filter((n) => (n.payload as { stage?: string }).stage === "review_counter");
      expect(reviewCounterNotifications.length).toBe(2);
    });

    it("business profile recipient resolution notifies the business owner, not a bare profile id", async () => {
      const { createTestNotificationService } = await import("@/lib/notify/testFakes");
      const notifyCtx = createTestNotificationService();
      const localCtx = createTestAgreementService(undefined, notifyCtx.notificationService);
      const creditorUserId = randomUUID();
      const businessOwnerUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const businessProfileId = randomUUID();
      localCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      localCtx.profileOwners.set("business", businessProfileId, businessOwnerUserId);
      const created = await localCtx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "business", id: businessProfileId },
        ...baseTerms(),
      });
      await localCtx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      const ownerNotifications = await notifyCtx.notificationService.listForUser(businessOwnerUserId);
      expect(ownerNotifications.some((n) => n.notificationType === "agreement_action_required")).toBe(true);
    });

    it("a notification-layer failure never fails the underlying agreement transition (failure isolation)", async () => {
      const { localCtx, created } = await setupNotifiedAgreement();
      // Replace the working notification service with one whose every call throws.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (localCtx.agreementService as any).deps.notifications = { notify: async () => { throw new Error("simulated_notify_outage"); } };
      await expect(localCtx.agreementService.submitDraft(created.agreement.id, created.agreement.createdByUserId)).resolves.toBeUndefined();
      const agreement = await localCtx.agreements.findById(created.agreement.id);
      expect(agreement?.status).toBe("awaiting_debtor_acknowledgment");
    });

    it("no notification is generated for a failed/rejected transition attempt (retry after a rejected request creates no false notification)", async () => {
      const { localCtx, notifyCtx, created, debtorUserId } = await setupNotifiedAgreement();
      // Wrong actor / wrong status: acknowledgeDebt before submitDraft ever ran.
      await expect(localCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId)).rejects.toThrow();
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtorUserId);
      expect(debtorNotifications).toHaveLength(0);
    });
  });

  describe(
    "PRSprint 26 (docs/prsprints/PRSPRINT_26_SEARCH_FILTER_PAGINATION_RECORD_MANAGEMENT.md): " +
      "listAgreements pagination",
    () => {
      it("returns a bounded page, newest-first, when pageParams are supplied — never the full unbounded set", async () => {
        const creditorUserId = randomUUID();
        const debtorProfileId = randomUUID();
        const creditorProfileId = randomUUID();
        ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
        ctx.profileOwners.set("personal", debtorProfileId, randomUUID());
        for (let i = 0; i < 5; i++) {
          await ctx.agreementService.createDraft({
            creatorUserId: creditorUserId,
            creditor: { kind: "personal", id: creditorProfileId },
            debtor: { kind: "personal", id: debtorProfileId },
            ...baseTerms(),
          });
        }
        const page = await ctx.agreementService.listAgreements(creditorUserId, { kind: "personal", id: creditorProfileId }, {
          limit: 3,
          offset: 0,
        });
        expect(page).toHaveLength(3);

        const nextPage = await ctx.agreementService.listAgreements(creditorUserId, { kind: "personal", id: creditorProfileId }, {
          limit: 3,
          offset: 3,
        });
        expect(nextPage).toHaveLength(2);
        // No overlap/duplication across pages.
        expect(page.map((a) => a.id)).not.toEqual(expect.arrayContaining(nextPage.map((a) => a.id)));
      });

      it("returns every matching agreement when pageParams are omitted (backward-compatible default)", async () => {
        const creditorUserId = randomUUID();
        const debtorProfileId = randomUUID();
        const creditorProfileId = randomUUID();
        ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
        ctx.profileOwners.set("personal", debtorProfileId, randomUUID());
        for (let i = 0; i < 4; i++) {
          await ctx.agreementService.createDraft({
            creatorUserId: creditorUserId,
            creditor: { kind: "personal", id: creditorProfileId },
            debtor: { kind: "personal", id: debtorProfileId },
            ...baseTerms(),
          });
        }
        const all = await ctx.agreementService.listAgreements(creditorUserId, { kind: "personal", id: creditorProfileId });
        expect(all).toHaveLength(4);
      });
    },
  );
});
