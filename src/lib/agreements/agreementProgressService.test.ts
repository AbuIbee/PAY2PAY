import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftTermsInput } from "./agreementService";
import { createTestAgreementService } from "./testFakes";
import {
  AgreementProgressService,
  type AgreementCancellationInfo,
  type AgreementCancellationReader,
  type PersonalProfileReader,
  type RelationshipPaymentMethodReader,
  type VerificationStateReader,
} from "./agreementProgressService";
import type { AgreementStatus } from "./agreementService";
import type { ProfileKind, VerificationState } from "@/lib/profiles/verificationService";

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: futureDate,
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

class FakeVerificationStateReader implements VerificationStateReader {
  states = new Map<string, VerificationState>();
  private key(kind: ProfileKind, id: string) {
    return `${kind}:${id}`;
  }
  set(kind: ProfileKind, id: string, state: VerificationState) {
    this.states.set(this.key(kind, id), state);
  }
  async getVerificationState(kind: ProfileKind, id: string): Promise<VerificationState> {
    return this.states.get(this.key(kind, id)) ?? "UNVERIFIED";
  }
}

class FakePersonalProfileReader implements PersonalProfileReader {
  byUserId = new Map<string, { id: string }>();
  async findByUserId(userId: string) {
    return this.byUserId.get(userId) ?? null;
  }
}

class FakeRelationshipPaymentMethodReader implements RelationshipPaymentMethodReader {
  byRelationship = new Map<string, Array<{ usage: "funding" | "payout"; status: string; financialAccount: { status: string } }>>();
  throwFor = new Set<string>();
  async getRelationshipAccounts(relationshipId: string) {
    if (this.throwFor.has(relationshipId)) throw new Error("not a participant");
    return this.byRelationship.get(relationshipId) ?? [];
  }
}

/** Reads the same in-memory audit trail AgreementService.cancelAgreement actually writes to (ctx.auditRepo.events) — real integration coverage, not a hand-fed stub. */
class FakeAgreementCancellationReader implements AgreementCancellationReader {
  constructor(private readonly auditRepo: { events: Array<{ agreementId: string | null; action: string; newValue: unknown }> }) {}
  async getCancellationInfo(agreementId: string): Promise<AgreementCancellationInfo | null> {
    const events = this.auditRepo.events.filter((e) => e.agreementId === agreementId && e.action === "agreement_cancelled");
    const last = events.at(-1);
    if (!last) return null;
    const value = last.newValue as { previousStatus?: unknown } | null;
    const previousStatus = typeof value?.previousStatus === "string" ? (value.previousStatus as AgreementStatus) : null;
    return previousStatus ? { previousStatus } : null;
  }
}

describe("AgreementProgressService", () => {
  let ctx: ReturnType<typeof createTestAgreementService>;
  let verification: FakeVerificationStateReader;
  let personalProfiles: FakePersonalProfileReader;
  let relationshipPaymentMethods: FakeRelationshipPaymentMethodReader;
  let progressService: AgreementProgressService;

  beforeEach(() => {
    ctx = createTestAgreementService();
    verification = new FakeVerificationStateReader();
    personalProfiles = new FakePersonalProfileReader();
    relationshipPaymentMethods = new FakeRelationshipPaymentMethodReader();
    progressService = new AgreementProgressService({
      agreementService: ctx.agreementService,
      verification,
      personalProfiles,
      relationshipPaymentMethods,
      cancellation: new FakeAgreementCancellationReader(ctx.auditRepo),
    });
  });

  /** Creates a P2P agreement and fully verifies both personal profiles by default (tests override as needed). */
  async function createAgreement(overrides: Partial<DraftTermsInput> = {}) {
    const creditorUserId = randomUUID();
    const debtorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    personalProfiles.byUserId.set(creditorUserId, { id: creditorProfileId });
    personalProfiles.byUserId.set(debtorUserId, { id: debtorProfileId });
    verification.set("personal", creditorProfileId, "FULL_VERIFIED");
    verification.set("personal", debtorProfileId, "FULL_VERIFIED");

    // Agreement Lifecycle V2: the debtor originates so the creditor is the counterparty and may
    // legitimately sign first in the tests below (signAgreement now requires the counterparty to
    // sign before the originator).
    // Agreement Lifecycle V2 UAT (Defect 5): createDraft now rejects a past firstPaymentDate
    // server-side — create with a valid (future) date, then mutate the version directly to simulate
    // the date having lapsed since creation, same pattern as agreementService.test.ts's own fixture.
    const { firstPaymentDate: staleDateOverride, ...restOverrides } = overrides;
    const created = await ctx.agreementService.createDraft({
      creatorUserId: debtorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(restOverrides),
    });
    if (staleDateOverride) {
      const version = await ctx.versions.findById(created.agreement.currentVersionId!);
      version!.terms = { ...version!.terms, firstPaymentDate: staleDateOverride };
    }
    return { agreementId: created.agreement.id, creditorUserId, debtorUserId, creditorProfileId, debtorProfileId };
  }

  async function advanceToAwaitingSignatures(agreementId: string, creditorUserId: string, debtorUserId: string) {
    await ctx.agreementService.submitDraft(agreementId, creditorUserId);
    await ctx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await ctx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
  }

  describe("details & terms", () => {
    it("is always complete once an agreement exists", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "details_terms")?.status).toBe("complete");
    });
  });

  describe("acceptance — role-aware, matches items 13-16", () => {
    it("draft: action_required for whichever party looks (either may submit)", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const creditorView = await progressService.getProgress(agreementId, creditorUserId);
      const debtorView = await progressService.getProgress(agreementId, debtorUserId);
      expect(creditorView.steps.find((s) => s.key === "acceptance")?.status).toBe("action_required");
      expect(debtorView.steps.find((s) => s.key === "acceptance")?.status).toBe("action_required");
    });

    it("awaiting_debtor_acknowledgment: action_required for the debtor, waiting for the creditor", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await ctx.agreementService.submitDraft(agreementId, creditorUserId);

      const creditorView = await progressService.getProgress(agreementId, creditorUserId);
      const debtorView = await progressService.getProgress(agreementId, debtorUserId);
      expect(creditorView.steps.find((s) => s.key === "acceptance")?.status).toBe("waiting");
      expect(debtorView.steps.find((s) => s.key === "acceptance")?.status).toBe("action_required");
    });

    it("awaiting_creditor_acceptance: action_required for the creditor, waiting for the debtor", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await ctx.agreementService.submitDraft(agreementId, creditorUserId);
      await ctx.agreementService.acknowledgeDebt(agreementId, debtorUserId);

      const creditorView = await progressService.getProgress(agreementId, creditorUserId);
      const debtorView = await progressService.getProgress(agreementId, debtorUserId);
      expect(creditorView.steps.find((s) => s.key === "acceptance")?.status).toBe("action_required");
      expect(debtorView.steps.find((s) => s.key === "acceptance")?.status).toBe("waiting");
    });

    it("complete once past creditor acceptance", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "acceptance")?.status).toBe("complete");
    });
  });

  describe("payment method — item: 'only require this step when the agreement type actually requires it'", () => {
    it("marks the step optional (not blocking) when the agreement has no linked relationship", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "payment_method")?.status).toBe("optional");
    });

    it("action_required with a direct CTA when linked to a relationship with no matching account assigned", async () => {
      const { agreementId, creditorUserId, debtorProfileId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, []);
      void debtorProfileId;

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "payment_method");
      expect(step?.status).toBe("action_required");
      expect(step?.cta).toEqual({ label: "Add payment method", href: "/payment-methods" });
    });

    it("complete once the acting party's required usage (funding for debtor, payout for creditor) is actively assigned", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);

      const creditorProgress = await progressService.getProgress(agreementId, creditorUserId);
      const debtorProgress = await progressService.getProgress(agreementId, debtorUserId);
      expect(creditorProgress.steps.find((s) => s.key === "payment_method")?.status).toBe("complete");
      expect(debtorProgress.steps.find((s) => s.key === "payment_method")?.status).toBe("complete");
    });

    it("degrades to optional (never crashes) if the relationship read fails — e.g. acting user isn't a participant", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.throwFor.add(relationshipId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "payment_method")?.status).toBe("optional");
    });
  });

  describe("identity verification — mirrors SignatureService.sign's exact gates (Problem 1's root cause)", () => {
    it("complete when fully verified", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "identity_verification")?.status).toBe("complete");
    });

    it("action_required (not a dead-end) for UNVERIFIED/BASIC, with a CTA straight to /account/verification", async () => {
      const { agreementId, creditorUserId, creditorProfileId } = await createAgreement();
      verification.set("personal", creditorProfileId, "BASIC");
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "identity_verification");
      expect(step?.status).toBe("action_required");
      expect(step?.cta).toEqual({ label: "Verify identity", href: "/account/verification" });
    });

    it("blocked (not action_required) while a submitted verification request is pending review — this is the exact live-UAT defect: the user already acted, they just can't self-resolve further", async () => {
      const { agreementId, creditorUserId, creditorProfileId } = await createAgreement();
      verification.set("personal", creditorProfileId, "FULL_PENDING");
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "identity_verification");
      expect(step?.status).toBe("blocked");
      expect(step?.description).toMatch(/being reviewed/i);
    });

    it("action_required for a rejected verification, inviting resubmission", async () => {
      const { agreementId, creditorUserId, creditorProfileId } = await createAgreement();
      verification.set("personal", creditorProfileId, "FULL_REJECTED");
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "identity_verification");
      expect(step?.status).toBe("action_required");
      expect(step?.description).toMatch(/rejected/i);
    });

    it("also requires the business party's own verification for a business-profile signer", async () => {
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorBusinessId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.profileOwners.set("business", creditorBusinessId, creditorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      personalProfiles.byUserId.set(creditorUserId, { id: randomUUID() });
      verification.set("personal", personalProfiles.byUserId.get(creditorUserId)!.id, "FULL_VERIFIED");
      verification.set("business", creditorBusinessId, "BASIC"); // business itself not yet verified

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "business", id: creditorBusinessId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });

      const progress = await progressService.getProgress(created.agreement.id, creditorUserId);
      const step = progress.steps.find((s) => s.key === "identity_verification");
      expect(step?.status).toBe("action_required");
      expect(step?.description).toMatch(/this business/i);
    });
  });

  describe("signatures — dependency-aware (item 16): never invites a signature that would just fail server-side", () => {
    it("not_started before the agreement reaches awaiting_signatures", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "signatures")?.status).toBe("not_started");
    });

    it("blocked, naming the exact prerequisite, when identity verification isn't complete — item 16", async () => {
      const { agreementId, creditorUserId, debtorUserId, creditorProfileId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      verification.set("personal", creditorProfileId, "BASIC");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "signatures");
      expect(step?.status).toBe("blocked");
      expect(step?.cta).toEqual({ label: "Verify identity", href: "/account/verification" });
    });

    it("blocked when the schedule's first payment date has already passed (Problem 2)", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement({ firstPaymentDate: "2020-01-01" });
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "signatures");
      expect(step?.status).toBe("blocked");
      expect(step?.description).toMatch(/2020-01-01/);
    });

    it("action_required once verification is complete and the date is valid", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "signatures")?.status).toBe("action_required");
    });

    it("waiting for the counterparty once I've signed — role-aware, item 'unauthorized CTA is not produced for the wrong party'", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);

      const creditorProgress = await progressService.getProgress(agreementId, creditorUserId);
      const debtorProgress = await progressService.getProgress(agreementId, debtorUserId);
      const creditorStep = creditorProgress.steps.find((s) => s.key === "signatures");
      const debtorStep = debtorProgress.steps.find((s) => s.key === "signatures");
      expect(creditorStep?.status).toBe("waiting");
      expect(creditorStep?.description).toMatch(/debtor/i);
      // The debtor still has an action to take — never shown as "waiting" for their own turn.
      expect(debtorStep?.status).toBe("action_required");
    });

    it("complete once fully signed", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      await ctx.agreementService.signAgreement(agreementId, debtorUserId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "signatures")?.status).toBe("complete");
    });

    it("Agreement Lifecycle V2 — the originator sees 'waiting' (never action_required) before the counterparty has signed, even though everything else is ready", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);

      // debtor originated (see createAgreement) — so the debtor must wait for the creditor (the
      // counterparty) to sign first, never shown as their turn.
      const debtorProgress = await progressService.getProgress(agreementId, debtorUserId);
      const debtorStep = debtorProgress.steps.find((s) => s.key === "signatures");
      expect(debtorStep?.status).toBe("waiting");
      expect(debtorStep?.description).toMatch(/other party must review and sign first/i);
    });

    it("Agreement Lifecycle V2 — once the counterparty signs, it genuinely becomes the originator's turn (action_required, not waiting)", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);

      const debtorProgress = await progressService.getProgress(agreementId, debtorUserId);
      const debtorStep = debtorProgress.steps.find((s) => s.key === "signatures");
      expect(debtorStep?.status).toBe("action_required");
    });
  });

  describe("active", () => {
    it("waiting while first_payment_pending", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      await ctx.agreementService.signAgreement(agreementId, debtorUserId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "active")?.status).toBe("waiting");
    });
  });

  describe("cancellation progress display fix — cancellation is a terminal workflow state", () => {
    it("1. cancelled before identity verification (during awaiting_debtor_acknowledgment): identity verification, signatures, and active all read Cancelled", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      await ctx.agreementService.submitDraft(agreementId, creditorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "Changed my mind.");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "identity_verification")?.status).toBe("cancelled");
      expect(progress.steps.find((s) => s.key === "signatures")?.status).toBe("cancelled");
      expect(progress.steps.find((s) => s.key === "active")?.status).toBe("cancelled");
    });

    it("2. a cancelled agreement's identity_verification step has no 'Verify identity' CTA, even for an unverified user", async () => {
      const { agreementId, creditorUserId, creditorProfileId } = await createAgreement();
      verification.set("personal", creditorProfileId, "UNVERIFIED");
      await ctx.agreementService.submitDraft(agreementId, creditorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "identity_verification");
      expect(step?.status).toBe("cancelled");
      expect(step?.cta).toBeNull();
    });

    it("3. a cancelled agreement's signatures step has no signing CTA, even mid-signature", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId); // counterparty (debtor originates) signs first
      await ctx.agreementService.cancelAgreement(agreementId, debtorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "signatures");
      expect(step?.status).toBe("cancelled");
      expect(step?.cta).toBeNull();
    });

    it("4. a cancelled agreement's active step has no activation CTA", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "active");
      expect(step?.status).toBe("cancelled");
      expect(step?.cta).toBeNull();
    });

    it("5. produces no misleading nextAction/primaryAction — no continuation CTA, a terminal label/description, and zero actionableForMeCount", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.primaryAction).toEqual({
        label: "Agreement cancelled",
        description: "No further action is required for this agreement.",
        cta: null,
      });
      expect(progress.actionableForMeCount).toBe(0);
      expect(progress.steps.some((s) => s.status === "action_required")).toBe(false);
      expect(progress.steps.some((s) => s.status === "blocked")).toBe(false);
    });

    it("6. historical steps genuinely completed before cancellation remain accurately Complete — acceptance had actually finished (cancelled at awaiting_signatures)", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "details_terms")?.status).toBe("complete");
      expect(progress.steps.find((s) => s.key === "acceptance")?.status).toBe("complete");
    });

    it("6b. does not retroactively claim acceptance completed if it never did (cancelled during awaiting_debtor_acknowledgment)", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      await ctx.agreementService.submitDraft(agreementId, creditorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "acceptance")?.status).toBe("cancelled");
    });

    it("7. an optional step (no linked relationship) remains accurately Optional even after cancellation", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "payment_method")?.status).toBe("optional");
    });

    it("the agreements-list attention label (primaryAction.label, the exact field GET /api/agreements reuses) never suggests action is needed for a cancelled agreement", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "test");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.primaryAction.label).toBe("Agreement cancelled");
      expect(progress.primaryAction.label).not.toMatch(/verify|sign|activate|payment method/i);
    });
  });

  describe("multiple missing requirements — 'do not simply send the user to the first problem and conceal the others'", () => {
    it("reports every actionable step, not just the first one found", async () => {
      const { agreementId, creditorUserId, debtorUserId, creditorProfileId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      verification.set("personal", creditorProfileId, "BASIC");
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, []);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const actionRequired = progress.steps.filter((s) => s.status === "action_required");
      // payment_method (creditor needs payout) and identity_verification both actionable at once.
      expect(actionRequired.map((s) => s.key).sort()).toEqual(["identity_verification", "payment_method"]);
      expect(progress.actionableForMeCount).toBe(2);
    });
  });

  describe("primary action — 'one obvious primary next action'", () => {
    it("prioritizes an action that's mine over a blocked/waiting step", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.primaryAction.label).toMatch(/sign|review/i);
    });

    it("surfaces the blocking prerequisite when nothing is actionable but something is blocked", async () => {
      const { agreementId, creditorUserId, debtorUserId, creditorProfileId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      verification.set("personal", creditorProfileId, "FULL_PENDING");
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.primaryAction.description).toMatch(/reviewed/i);
    });

    it("reports 'waiting for other party' once I've done everything I can", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.primaryAction.label).toBe("Waiting for other party");
    });
  });
});
