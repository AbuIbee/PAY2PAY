import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { AmendmentService } from "./amendmentService";
import { createTestAmendmentService } from "./testFakes";

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

describe("AmendmentService", () => {
  let ctx: ReturnType<typeof createTestAmendmentService>;
  let creditorUserId: string;
  let debtorUserId: string;
  let agreementId: string;
  let originalVersionId: string;

  beforeEach(async () => {
    ctx = createTestAmendmentService();
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

  it("proposal: the borrower can propose an amendment, capturing reason/relief/effective date/replacement terms", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "Lost overtime hours at work",
      requestedRelief: "Reduce installment to $150/month",
      proposedEffectiveDate: "2026-03-01",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });
    expect(amendment.status).toBe("proposed");
    expect(amendment.proposingPartyRole).toBe("debtor");
    expect(amendment.reason).toBe("Lost overtime hours at work");
    expect(amendment.requestedRelief).toBe("Reduce installment to $150/month");
    expect(amendment.proposedEffectiveDate).toBe("2026-03-01");
    expect(amendment.terms.installmentAmountMinorUnits).toBe(15_000);
    // The existing agreement remains controlling — nothing changed on it yet.
    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.currentVersionId).toBe(originalVersionId);
  });

  it("rejection: the creditor can reject a proposed amendment outright, and the agreement is unaffected", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "temporary_pause",
      reason: "Medical emergency",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    const decided = await ctx.amendmentService.decideAmendment({
      amendmentId: amendment.id,
      actingUserId: creditorUserId,
      decision: "reject",
      reason: "Not enough information provided",
    });
    expect(decided.status).toBe("rejected");
    expect(decided.rejectedReason).toBe("Not enough information provided");
    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.status).not.toBe("paused_by_amendment");
    expect(agreement?.currentVersionId).toBe(originalVersionId);
  });

  it("counter: the creditor can counter with different terms, mutating the same proposal and flipping whose turn it is", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "Lost overtime hours",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 10_000 }),
      actingUserId: debtorUserId,
    });
    const countered = await ctx.amendmentService.decideAmendment({
      amendmentId: amendment.id,
      actingUserId: creditorUserId,
      decision: "counter",
      counterTerms: baseTerms({ installmentAmountMinorUnits: 17_000 }),
      counterReason: "Can meet partway",
    });
    expect(countered.status).toBe("proposed"); // still negotiating, no new state
    expect(countered.proposingPartyRole).toBe("creditor"); // whoever countered now holds the ball
    expect(countered.terms.installmentAmountMinorUnits).toBe(17_000);
    expect(countered.reason).toBe("Can meet partway");
    expect(countered.id).toBe(amendment.id); // same row, not a new one

    // Now the debtor (the original proposer) is the one who must respond — the creditor cannot decide their own counter.
    await expect(
      ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);
    const accepted = await ctx.amendmentService.decideAmendment({
      amendmentId: amendment.id,
      actingUserId: debtorUserId,
      decision: "accept",
    });
    expect(accepted.status).toBe("awaiting_signatures");
  });

  it("dual acceptance / version creation: once both parties sign, a new immutable version is created and becomes current", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "Lost overtime hours",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });

    const afterOneSignature = await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
    expect(afterOneSignature.status).toBe("awaiting_signatures"); // only one party has signed so far
    expect(afterOneSignature.creditorSignedAt).not.toBeNull();
    expect(afterOneSignature.debtorSignedAt).toBeNull();

    const applied = await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });
    expect(applied.status).toBe("applied");
    expect(applied.resultingVersionId).toBeTruthy();
    expect(applied.resultingVersionId).not.toBe(originalVersionId);

    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.currentVersionId).toBe(applied.resultingVersionId);

    const newVersion = await ctx.agreementCtx.versions.findById(applied.resultingVersionId!);
    expect(newVersion?.versionNumber).toBe(2);
    expect(newVersion?.parentVersionId).toBe(originalVersionId);
    expect(newVersion?.isOriginal).toBe(false);
    expect(newVersion?.terms.installmentAmountMinorUnits).toBe(15_000);
    expect(newVersion?.signedAt).not.toBeNull();
    expect(newVersion?.documentHash).toBeTruthy();
  });

  /**
   * PRSprint 11 (docs/prsprints/PRSPRINT_11_AGREEMENT_VERSIONING_AMENDMENTS_MUTUAL_APPROVAL.md)
   * Hard Stop rule: "Stop if an amendment can partially apply." Every write `applyAmendment`
   * performs (new version, its schedule, the agreement's current-version pointer/status, the
   * amendment's own "applied" marker) now goes through exactly one call to
   * `AmendmentApplicationRepository.applyAtomically`, itself one `db.transaction` in production
   * (DrizzleAmendmentApplicationRepository) — so a failure there fails as a single, all-or-nothing
   * unit, which a real Postgres transaction rolls back completely. This test proves the *service's*
   * half of that guarantee: if the atomic write fails, the amendment is left exactly where it was
   * before the attempt (still "signed", not stuck in some new corrupted in-between state), so a
   * retry remains safe. (True DB rollback itself is a property of the transaction, not something an
   * in-memory fake can simulate — this is that fake's own documented boundary.)
   */
  it("atomicity: if the atomic apply write fails, the amendment stays 'signed' (not corrupted into a partial state) and the agreement's current version is unchanged", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "Lost overtime hours",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });

    const noopAudit = new AuditService({
      getLastEvent: async () => null,
      insertEvent: async (record) => ({ ...record, id: 1 }),
    });
    const failingService = new AmendmentService({
      agreementService: ctx.agreementCtx.agreementService,
      amendments: ctx.amendments,
      versions: ctx.agreementCtx.versions,
      application: { applyAtomically: async () => { throw new Error("simulated_transaction_failure"); } },
      audit: noopAudit,
      profileOwners: ctx.agreementCtx.profileOwners,
    });

    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
    await expect(
      failingService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId }),
    ).rejects.toThrow("simulated_transaction_failure");

    const stuck = await ctx.amendments.findById(amendment.id);
    expect(stuck?.status).toBe("signed"); // not "applied" — safe to retry, never left half-done
    expect(stuck?.resultingVersionId).toBeNull();
    const agreementAfter = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreementAfter?.currentVersionId).toBe(originalVersionId); // unchanged
  });

  it("historical versions retrievable: AgreementService.listVersionHistory returns both the original and the amended version, oldest first", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "Lost overtime hours",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
    const applied = await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });

    const history = await ctx.agreementCtx.agreementService.listVersionHistory(agreementId, creditorUserId);
    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe(originalVersionId);
    expect(history[0]!.versionNumber).toBe(1);
    expect(history[0]!.terms.installmentAmountMinorUnits).toBe(20_000);
    expect(history[1]!.id).toBe(applied.resultingVersionId);
    expect(history[1]!.versionNumber).toBe(2);
    expect(history[1]!.terms.installmentAmountMinorUnits).toBe(15_000);

    // A stranger cannot list this agreement's version history either.
    await expect(ctx.agreementCtx.agreementService.listVersionHistory(agreementId, randomUUID())).rejects.toThrow(ForbiddenError);
  });

  it("original preserved: the original agreement_version is never mutated by an applied amendment", async () => {
    const originalBefore = await ctx.agreementCtx.versions.findById(originalVersionId);

    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "Lost overtime hours",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });

    const originalAfter = await ctx.agreementCtx.versions.findById(originalVersionId);
    expect(originalAfter).toEqual(originalBefore);
    expect(originalAfter?.terms.installmentAmountMinorUnits).toBe(20_000); // unchanged from the original draft
    expect(originalAfter?.versionNumber).toBe(1);
  });

  it("unauthorized change blocked: a user who is not a party to the agreement cannot propose, decide, or sign", async () => {
    const outsiderUserId = randomUUID();
    await expect(
      ctx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "general",
        reason: "x",
        proposedTerms: baseTerms(),
        actingUserId: outsiderUserId,
      }),
    ).rejects.toThrow(ForbiddenError);

    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "x",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    await expect(
      ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: outsiderUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);

    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    await expect(
      ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: outsiderUserId }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("unauthorized change blocked: the proposer cannot decide their own proposal", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "x",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    await expect(
      ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("unauthorized change blocked: a business-staff creditor without approve_agreement cannot decide an amendment, but a manager (who has it) can", async () => {
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

    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId: b2c.agreement.id,
      changeType: "general",
      reason: "x",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId2,
    });

    // A viewer-role staff member is an active party (resolvePartyRole succeeds) but lacks
    // approve_agreement — this is exactly the gap the Sprint 14 review pass found and fixed.
    await expect(
      ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorViewerUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);

    // A manager holds approve_agreement by default and can decide it.
    const decided = await ctx.amendmentService.decideAmendment({
      amendmentId: amendment.id,
      actingUserId: creditorManagerUserId,
      decision: "accept",
    });
    expect(decided.status).toBe("awaiting_signatures");
  });

  it("temporary pause: an applied pause-type amendment transitions the agreement to paused_by_amendment", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "temporary_pause",
      reason: "Medical emergency",
      requestedRelief: "Pause payments for 2 months",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });

    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.status).toBe("paused_by_amendment");
  });

  it("a non-pause amendment never changes the agreement's own status", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "x",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });

    const agreement = await ctx.agreementCtx.agreements.findById(agreementId);
    expect(agreement?.status).toBe("first_payment_pending"); // unchanged from before the amendment
  });

  it("signature evidence: signAmendment records the caller-supplied ipAddress/deviceInfo on the signing audit entries", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "x",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.amendmentService.signAmendment({
      amendmentId: amendment.id,
      actingUserId: creditorUserId,
      ipAddress: "203.0.113.7",
      deviceInfo: { userAgent: "test-agent" },
    });

    const signingEvent = ctx.auditRepo.events.find((e) => e.action === "amendment_signed_by_party");
    expect(signingEvent?.ipAddress).toBe("203.0.113.7");
    expect(signingEvent?.deviceInfo).toEqual({ userAgent: "test-agent" });
  });

  it("withdrawal: only the proposer can withdraw their own not-yet-fully-signed amendment", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "x",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    await expect(
      ctx.amendmentService.withdrawAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId }),
    ).rejects.toThrow(ForbiddenError);
    const withdrawn = await ctx.amendmentService.withdrawAmendment({
      amendmentId: amendment.id,
      actingUserId: debtorUserId,
      reason: "Situation resolved itself",
    });
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("rejects deciding an amendment that is no longer in the proposed state", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "x",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "reject" });
    await expect(
      ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" }),
    ).rejects.toThrow(ValidationError);
  });

  it("audits every step of the lifecycle", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "x",
      proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
    await ctx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });

    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual([
      "amendment_proposed",
      "amendment_accepted",
      "amendment_signed_by_party",
      "amendment_signed_by_party",
      "amendment_fully_signed",
      "amendment_applied",
    ]);
  });

  /**
   * PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): before this,
   * AmendmentService never called NotificationService.notify at all, despite `amendment` existing in
   * the taxonomy since Sprint 17 for exactly this purpose. Uses its own local `notifiedCtx`
   * (constructed with a real NotificationService) rather than the outer `beforeEach`'s, which omits it.
   */
  describe("PRSprint 13: notification wiring", () => {
    async function setupNotified() {
      const { createTestNotificationService } = await import("@/lib/notify/testFakes");
      const notifyCtx = createTestNotificationService();
      const notifiedCtx = createTestAmendmentService(notifyCtx.notificationService);
      const creditor = randomUUID();
      const debtor = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      notifiedCtx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditor);
      notifiedCtx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtor);
      const created = await notifiedCtx.agreementCtx.agreementService.createDraft({
        creatorUserId: creditor,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await notifiedCtx.agreementCtx.agreementService.submitDraft(created.agreement.id, creditor);
      await notifiedCtx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtor);
      await notifiedCtx.agreementCtx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditor, decision: "accept" });
      await notifiedCtx.agreementCtx.agreementService.signAgreement(created.agreement.id, creditor);
      await notifiedCtx.agreementCtx.agreementService.signAgreement(created.agreement.id, debtor);
      return { notifiedCtx, notifyCtx, agreementId: created.agreement.id, creditor, debtor };
    }

    it("proposeAmendment notifies the counterparty (recipient resolution: proposer's opposite role)", async () => {
      const { notifiedCtx, notifyCtx, agreementId, creditor, debtor } = await setupNotified();
      await notifiedCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "Lost overtime hours",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtor,
      });
      const creditorNotifications = await notifyCtx.notificationService.listForUser(creditor);
      expect(creditorNotifications.some((n) => n.notificationType === "amendment")).toBe(true);
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtor);
      expect(debtorNotifications.some((n) => n.notificationType === "amendment")).toBe(false);
    });

    it("decideAmendment(accept) notifies the original proposer with decision=accepted", async () => {
      const { notifiedCtx, notifyCtx, agreementId, creditor, debtor } = await setupNotified();
      const amendment = await notifiedCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "x",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtor,
      });
      await notifiedCtx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditor, decision: "accept" });
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtor);
      const decided = debtorNotifications.find((n) => n.notificationType === "amendment_decided");
      expect(decided?.payload).toMatchObject({ decision: "accepted" });
    });

    it("decideAmendment(reject) notifies the original proposer with decision=rejected", async () => {
      const { notifiedCtx, notifyCtx, agreementId, creditor, debtor } = await setupNotified();
      const amendment = await notifiedCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "x",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtor,
      });
      await notifiedCtx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditor, decision: "reject", reason: "no" });
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtor);
      const decided = debtorNotifications.find((n) => n.notificationType === "amendment_decided");
      expect(decided?.payload).toMatchObject({ decision: "rejected" });
    });

    it("signAmendment: first signer notifies the other party; once both have signed, notifies both parties that the amendment is applied", async () => {
      const { notifiedCtx, notifyCtx, agreementId, creditor, debtor } = await setupNotified();
      const amendment = await notifiedCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "x",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtor,
      });
      await notifiedCtx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditor, decision: "accept" });

      await notifiedCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditor });
      const debtorAfterFirstSign = await notifyCtx.notificationService.listForUser(debtor);
      expect(debtorAfterFirstSign.some((n) => n.notificationType === "agreement_counterparty_signed")).toBe(true);

      await notifiedCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtor });
      const creditorFinal = await notifyCtx.notificationService.listForUser(creditor);
      const debtorFinal = await notifyCtx.notificationService.listForUser(debtor);
      expect(creditorFinal.some((n) => n.notificationType === "amendment_decided" && (n.payload as { decision?: string }).decision === "applied")).toBe(
        true,
      );
      expect(debtorFinal.some((n) => n.notificationType === "amendment_decided" && (n.payload as { decision?: string }).decision === "applied")).toBe(
        true,
      );
    });

    it("a notification-layer failure never fails the underlying amendment transition (failure isolation)", async () => {
      const { notifiedCtx, agreementId, debtor } = await setupNotified();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (notifiedCtx.amendmentService as any).deps.notifications = { notify: async () => { throw new Error("simulated_notify_outage"); } };
      const amendment = await notifiedCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "x",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtor,
      });
      expect(amendment.status).toBe("proposed");
    });
  });
});
