import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftTermsInput } from "./agreementService";
import { createTestAgreementService } from "./testFakes";
import {
  AgreementProgressService,
  type AgreementBalanceReader,
  type AgreementCancellationInfo,
  type AgreementCancellationReader,
  type AgreementInstallmentStatusReader,
  type AgreementMandateReader,
  type AgreementPaymentAttemptRecord,
  type AgreementPaymentAttemptsReader,
  type InstallmentWithStatus,
  type RelationshipPaymentMethodReader,
} from "./agreementProgressService";
import type { AgreementStatus } from "./agreementService";

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

class FakeRelationshipPaymentMethodReader implements RelationshipPaymentMethodReader {
  byRelationship = new Map<string, Array<{ usage: "funding" | "payout"; status: string; financialAccount: { status: string } }>>();
  throwFor = new Set<string>();
  async getRelationshipAccounts(relationshipId: string) {
    if (this.throwFor.has(relationshipId)) throw new Error("not a participant");
    return this.byRelationship.get(relationshipId) ?? [];
  }
}

class FakeAgreementMandateReader implements AgreementMandateReader {
  active = new Set<string>();
  async isActiveForAgreement(agreementId: string): Promise<boolean> {
    return this.active.has(agreementId);
  }
}

/**
 * Restore agreement payment functionality: derives installment rows from the SAME in-memory
 * schedule repository AgreementService itself writes to at draft creation (ctx.scheduleItems) —
 * matching the production invariant that a schedule already exists as soon as an agreement is
 * created — rather than requiring every test that reaches Step 5's installment logic to hand-seed a
 * schedule from scratch. `markPaid` lets a test simulate a cleared installment without needing the
 * full ledger/payment stack.
 */
class FakeAgreementInstallmentStatusReader implements AgreementInstallmentStatusReader {
  constructor(private readonly ctx: ReturnType<typeof createTestAgreementService>) {}
  private paidSequenceNumbers = new Map<string, Set<number>>();

  markPaid(agreementId: string, sequenceNumber: number) {
    const set = this.paidSequenceNumbers.get(agreementId) ?? new Set<number>();
    set.add(sequenceNumber);
    this.paidSequenceNumbers.set(agreementId, set);
  }

  async listForAgreement(agreementId: string): Promise<InstallmentWithStatus[]> {
    const agreement = this.ctx.agreements.byId.get(agreementId);
    if (!agreement?.currentVersionId) return [];
    const items = await this.ctx.scheduleItems.listForVersion(agreement.currentVersionId);
    const paid = this.paidSequenceNumbers.get(agreementId);
    return items.map((item) => ({
      id: `${agreementId}:${item.sequenceNumber}`,
      sequenceNumber: item.sequenceNumber,
      dueDate: item.dueDate,
      amountMinorUnits: item.amountMinorUnits,
      status: paid?.has(item.sequenceNumber) ? "paid" : "scheduled",
    }));
  }
}

class FakeAgreementPaymentAttemptsReader implements AgreementPaymentAttemptsReader {
  byAgreement = new Map<string, AgreementPaymentAttemptRecord[]>();
  async listByAgreementId(agreementId: string): Promise<AgreementPaymentAttemptRecord[]> {
    return this.byAgreement.get(agreementId) ?? [];
  }
}

/** Defaults to "not computable" (matches a genuine gap, e.g. no signed version yet) so tests that don't care about the remaining-balance suffix aren't forced to seed one. */
class FakeAgreementBalanceReader implements AgreementBalanceReader {
  byAgreement = new Map<string, { remainingBalanceMinorUnits: number; currency: string; settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid" }>();
  async getAgreementBalance(agreementId: string) {
    const balance = this.byAgreement.get(agreementId);
    if (!balance) throw new Error("no balance seeded for this agreement");
    return balance;
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
  let relationshipPaymentMethods: FakeRelationshipPaymentMethodReader;
  let mandates: FakeAgreementMandateReader;
  let installments: FakeAgreementInstallmentStatusReader;
  let paymentAttempts: FakeAgreementPaymentAttemptsReader;
  let balance: FakeAgreementBalanceReader;
  let progressService: AgreementProgressService;

  beforeEach(() => {
    ctx = createTestAgreementService();
    relationshipPaymentMethods = new FakeRelationshipPaymentMethodReader();
    mandates = new FakeAgreementMandateReader();
    installments = new FakeAgreementInstallmentStatusReader(ctx);
    paymentAttempts = new FakeAgreementPaymentAttemptsReader();
    balance = new FakeAgreementBalanceReader();
    progressService = new AgreementProgressService({
      agreementService: ctx.agreementService,
      relationshipPaymentMethods,
      cancellation: new FakeAgreementCancellationReader(ctx.auditRepo),
      mandates,
      installments,
      paymentAttempts,
      balance,
    });
  });

  async function createAgreement(overrides: Partial<DraftTermsInput> = {}) {
    const creditorUserId = randomUUID();
    const debtorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);

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
    it("Fix the 'Make payment' button: reports 'blocked' (never a falsely-reassuring 'optional') when the agreement has no linked relationship, since no relationship-scoped funding/payout account can ever be assigned", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "payment_method");
      expect(step?.status).toBe("blocked");
      expect(step?.statusText).toBe("Payout setup unavailable");
      expect(step?.cta).toEqual({ label: "Contact support", href: "/support" });
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
      expect(step?.statusText).toBe("Payout setup required");
      expect(step?.cta).toEqual({ label: "Set up payout account", href: "/payment-methods" });
    });

    it("complete once the debtor's funding account + agreement mandate and the creditor's payout account are all active", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);

      const creditorProgress = await progressService.getProgress(agreementId, creditorUserId);
      const debtorProgress = await progressService.getProgress(agreementId, debtorUserId);
      expect(creditorProgress.steps.find((s) => s.key === "payment_method")?.status).toBe("complete");
      expect(debtorProgress.steps.find((s) => s.key === "payment_method")?.status).toBe("complete");
    });

    it("debtor sees 'action required' with a mandate-authorize CTA when a funding account is assigned but the agreement mandate isn't authorized yet", async () => {
      const { agreementId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
      ]);

      const progress = await progressService.getProgress(agreementId, debtorUserId);
      const step = progress.steps.find((s) => s.key === "payment_method");
      expect(step?.status).toBe("action_required");
      expect(step?.statusText).toBe("Payment setup required");
      expect(step?.cta).toEqual({ label: "Set up payment method", href: `/agreements/payment-authorize?id=${agreementId}` });
    });

    it("each party sees only their own missing requirement — never sent into the other party's account setup", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, []);

      const creditorStep = (await progressService.getProgress(agreementId, creditorUserId)).steps.find((s) => s.key === "payment_method");
      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "payment_method");
      expect(creditorStep?.statusText).toBe("Payout setup required");
      expect(debtorStep?.statusText).toBe("Payment setup required");
    });

    it("degrades to blocked (never crashes, never falsely 'optional') if the relationship read fails — e.g. acting user isn't a participant", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.throwFor.add(relationshipId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "payment_method")?.status).toBe("blocked");
    });
  });

  describe("Production follow-up (Remove Step 4 — Identity Verification): identity verification is no longer a progress step at all", () => {
    it("the steps array has exactly 5 steps, in order, with no identity_verification key", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.map((s) => s.key)).toEqual(["details_terms", "acceptance", "payment_method", "signatures", "active"]);
    });
  });

  describe("signatures — dependency-aware (item 16): never invites a signature that would just fail server-side", () => {
    it("not_started before the agreement reaches awaiting_signatures", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "signatures")?.status).toBe("not_started");
    });

    it("blocked when the schedule's first payment date has already passed (Problem 2)", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement({ firstPaymentDate: "2020-01-01" });
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "signatures");
      expect(step?.status).toBe("blocked");
      expect(step?.description).toMatch(/2020-01-01/);
    });

    it("action_required once awaiting signatures and the date is valid", async () => {
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

  describe("active — restore agreement payment functionality: truthful post-signing readiness, never a generic 'Waiting on other party'", () => {
    async function signBoth(agreementId: string, creditorUserId: string, debtorUserId: string) {
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      await ctx.agreementService.signAgreement(agreementId, debtorUserId);
    }

    it("Fix the 'Make payment' button: no linked relationship — reports the same truthful 'blocked' state as Step 3, never a 'Make payment' CTA that can't lead to a working payment", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await signBoth(agreementId, creditorUserId, debtorUserId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const step = progress.steps.find((s) => s.key === "active");
      expect(step?.status).toBe("blocked");
      expect(step?.cta).not.toEqual({ label: "Make payment", href: expect.stringContaining("#make-payment") });
    });

    it("STATE B — debtor funding/mandate missing: debtor sees 'Payment setup required', creditor sees 'Waiting for debtor payment setup' with no action of their own", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      await signBoth(agreementId, creditorUserId, debtorUserId);

      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "active");
      const creditorStep = (await progressService.getProgress(agreementId, creditorUserId)).steps.find((s) => s.key === "active");
      expect(debtorStep?.status).toBe("action_required");
      expect(debtorStep?.statusText).toBe("Payment setup required");
      expect(debtorStep?.cta).not.toBeNull();
      expect(creditorStep?.status).toBe("waiting");
      expect(creditorStep?.statusText).toBe("Waiting for debtor payment setup");
      expect(creditorStep?.cta).toBeNull();
    });

    it("STATE C — creditor payout missing: creditor sees 'Payout setup required', debtor sees 'Waiting for creditor payout setup' and is never asked to fix the creditor's account", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await signBoth(agreementId, creditorUserId, debtorUserId);

      const creditorStep = (await progressService.getProgress(agreementId, creditorUserId)).steps.find((s) => s.key === "active");
      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "active");
      expect(creditorStep?.status).toBe("action_required");
      expect(creditorStep?.statusText).toBe("Payout setup required");
      expect(debtorStep?.status).toBe("waiting");
      expect(debtorStep?.statusText).toBe("Waiting for creditor payout setup");
      expect(debtorStep?.cta).toBeNull();
    });

    it("STATE A — both ready, nothing overdue: debtor sees 'Next payment scheduled' with a Make Payment CTA, creditor sees the same status with no CTA", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await signBoth(agreementId, creditorUserId, debtorUserId);

      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "active");
      const creditorStep = (await progressService.getProgress(agreementId, creditorUserId)).steps.find((s) => s.key === "active");
      expect(debtorStep?.status).toBe("waiting");
      expect(debtorStep?.statusText).toBe("Next payment scheduled");
      expect(debtorStep?.cta).toEqual({ label: "Make payment", href: `/agreements/detail?id=${agreementId}#make-payment` });
      expect(creditorStep?.statusText).toBe("Next payment scheduled");
      expect(creditorStep?.cta).toBeNull();
    });

    it("mentions the remaining balance when it's computable, and degrades silently (no crash, no stale text) when it isn't", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await signBoth(agreementId, creditorUserId, debtorUserId);
      balance.byAgreement.set(agreementId, { remainingBalanceMinorUnits: 100_000, currency: "USD", settlementState: "unpaid" });

      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "active");
      expect(debtorStep?.description).toMatch(/Remaining balance: \$1,000\.00/);
    });

    it("overdue next payment: debtor sees 'Payment due' as action_required with a Make Payment CTA", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await signBoth(agreementId, creditorUserId, debtorUserId);
      const version = await ctx.versions.findById(ctx.agreements.byId.get(agreementId)!.currentVersionId!);
      const items = await ctx.scheduleItems.listForVersion(version!.id);
      items[0]!.dueDate = "2020-01-01";
      await ctx.scheduleItems.replaceForVersion(version!.id, items);

      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "active");
      expect(debtorStep?.status).toBe("action_required");
      expect(debtorStep?.statusText).toBe("Payment due");
    });

    it("STATE D — an open payment attempt for the next-due installment reads 'Payment processing' for both parties", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await signBoth(agreementId, creditorUserId, debtorUserId);
      paymentAttempts.byAgreement.set(agreementId, [
        { installmentScheduleItemId: `${agreementId}:0`, status: "processing", failureReason: null, createdAt: new Date() },
      ]);

      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "active");
      expect(debtorStep?.status).toBe("waiting");
      expect(debtorStep?.statusText).toBe("Payment processing");
      expect(debtorStep?.cta).toBeNull();
    });

    it("a failed payment attempt: debtor sees 'Payment failed — action required' with a retry CTA and the safely-showable reason; creditor sees a non-actionable 'not yet completed' status", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await signBoth(agreementId, creditorUserId, debtorUserId);
      paymentAttempts.byAgreement.set(agreementId, [
        { installmentScheduleItemId: `${agreementId}:0`, status: "failed", failureReason: "insufficient_funds", createdAt: new Date() },
      ]);

      const debtorStep = (await progressService.getProgress(agreementId, debtorUserId)).steps.find((s) => s.key === "active");
      const creditorStep = (await progressService.getProgress(agreementId, creditorUserId)).steps.find((s) => s.key === "active");
      expect(debtorStep?.status).toBe("action_required");
      expect(debtorStep?.statusText).toBe("Payment failed — action required");
      expect(debtorStep?.description).toMatch(/insufficient_funds/);
      expect(debtorStep?.cta).toEqual({ label: "Make payment", href: `/agreements/detail?id=${agreementId}#make-payment` });
      expect(creditorStep?.status).toBe("waiting");
      expect(creditorStep?.statusText).toBe("Payment not yet completed");
    });

    it("STATE E — every installment paid: reads 'Agreement paid in full' as complete", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await signBoth(agreementId, creditorUserId, debtorUserId);
      const version = await ctx.versions.findById(ctx.agreements.byId.get(agreementId)!.currentVersionId!);
      const items = await ctx.scheduleItems.listForVersion(version!.id);
      for (const item of items) installments.markPaid(agreementId, item.sequenceNumber);

      const step = (await progressService.getProgress(agreementId, creditorUserId)).steps.find((s) => s.key === "active");
      expect(step?.status).toBe("complete");
      expect(step?.statusText).toBe("Agreement paid in full");
    });
  });

  describe("cancellation progress display fix — cancellation is a terminal workflow state", () => {
    it("1. cancelled during awaiting_debtor_acknowledgment: signatures and active both read Cancelled", async () => {
      const { agreementId, creditorUserId } = await createAgreement();
      await ctx.agreementService.submitDraft(agreementId, creditorUserId);
      await ctx.agreementService.cancelAgreement(agreementId, creditorUserId, "Changed my mind.");

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.steps.find((s) => s.key === "signatures")?.status).toBe("cancelled");
      expect(progress.steps.find((s) => s.key === "active")?.status).toBe("cancelled");
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
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, []);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      const actionRequired = progress.steps.filter((s) => s.status === "action_required");
      // payment_method (creditor needs payout) and signatures both actionable at once.
      expect(actionRequired.map((s) => s.key).sort()).toEqual(["payment_method", "signatures"]);
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
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement({ firstPaymentDate: "2020-01-01" });
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      // Isolate the signatures block being tested from the (also now legitimately "blocked")
      // no-relationship payment_method state — link a relationship with fully-ready accounts so
      // payment_method reads "complete" and the signatures block is the only one left to surface.
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);

      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.primaryAction.description).toMatch(/2020-01-01/);
    });

    it("reports 'waiting for other party' once I've done everything I can", async () => {
      const { agreementId, creditorUserId, debtorUserId } = await createAgreement();
      await advanceToAwaitingSignatures(agreementId, creditorUserId, debtorUserId);
      // Isolate the signatures wait being tested from the (also now legitimately "blocked")
      // no-relationship payment_method state — link a relationship with fully-ready accounts.
      const relationshipId = randomUUID();
      ctx.agreements.byId.get(agreementId)!.relationshipId = relationshipId;
      relationshipPaymentMethods.byRelationship.set(relationshipId, [
        { usage: "funding", status: "active", financialAccount: { status: "verified" } },
        { usage: "payout", status: "active", financialAccount: { status: "verified" } },
      ]);
      mandates.active.add(agreementId);
      await ctx.agreementService.signAgreement(agreementId, creditorUserId);
      const progress = await progressService.getProgress(agreementId, creditorUserId);
      expect(progress.primaryAction.label).toBe("Waiting for other party");
    });
  });
});
