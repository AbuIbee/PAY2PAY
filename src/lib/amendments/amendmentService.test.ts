import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { hashPdfContent } from "@/lib/documents/agreementPdf";
import { extractPdfText } from "@/lib/documents/pdfTextTestHelper";
import { grantStepUp } from "@/lib/signatures/testFakes";
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

    // Agreement Lifecycle V2: the debtor originates so the creditor is the counterparty and may
    // legitimately sign first (signAgreement now requires the counterparty to sign before the
    // originator) — this file's tests only care about the agreement being fully signed already, not
    // about who originated it.
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

  it("test 24 (Decision 7): the original agreement's identity snapshot is frozen at creditorDecide(accept) — before either signature exists", async () => {
    // The suite's own beforeEach already carried the original agreement through creditorDecide(accept)
    // and both signatures. Re-derive the snapshot repo's state by proposing/accepting/signing a SECOND,
    // fresh agreement so the accept-but-not-yet-signed moment can be observed directly.
    const localCtx = createTestAmendmentService();
    const localCreditor = randomUUID();
    const localDebtor = randomUUID();
    const localCreditorProfileId = randomUUID();
    const localDebtorProfileId = randomUUID();
    localCtx.agreementCtx.profileOwners.set("personal", localCreditorProfileId, localCreditor);
    localCtx.agreementCtx.profileOwners.set("personal", localDebtorProfileId, localDebtor);
    const created = await localCtx.agreementCtx.agreementService.createDraft({
      creatorUserId: localDebtor,
      creditor: { kind: "personal", id: localCreditorProfileId },
      debtor: { kind: "personal", id: localDebtorProfileId },
      ...baseTerms(),
    });
    await localCtx.agreementCtx.agreementService.submitDraft(created.agreement.id, localCreditor);
    await localCtx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, localDebtor);
    await localCtx.agreementCtx.agreementService.creditorDecide({
      agreementId: created.agreement.id,
      actingUserId: localCreditor,
      decision: "accept",
    });

    const rowsBeforeSigning = localCtx.agreementCtx.snapshotRepo.rows.filter((r) => r.agreementVersionId === created.version.id);
    expect(rowsBeforeSigning).toHaveLength(2); // creditor + debtor, frozen at accept — not deferred until signing

    const agreement = await localCtx.agreementCtx.agreements.findById(created.agreement.id);
    expect(agreement?.status).toBe("awaiting_signatures"); // proves this froze strictly before either signature
  });

  it("test 25 (Decision 7): a fully-signed amendment gets its OWN new immutable snapshot, without overwriting the prior version's", async () => {
    const originalRows = [...ctx.agreementCtx.snapshotRepo.rows.filter((r) => r.agreementVersionId === originalVersionId)];
    expect(originalRows).toHaveLength(2);

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

    const newRows = ctx.agreementCtx.snapshotRepo.rows.filter((r) => r.agreementVersionId === applied.resultingVersionId);
    expect(newRows).toHaveLength(2);

    // The prior version's rows are byte-for-byte unchanged — an amendment never overwrites them.
    const originalRowsAfter = ctx.agreementCtx.snapshotRepo.rows.filter((r) => r.agreementVersionId === originalVersionId);
    expect(originalRowsAfter).toEqual(originalRows);
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
        creatorUserId: debtor,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await notifiedCtx.agreementCtx.agreementService.submitDraft(created.agreement.id, creditor);
      await notifiedCtx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtor);
      await notifiedCtx.agreementCtx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditor, decision: "accept" });
      await notifiedCtx.agreementCtx.agreementService.signAgreement(created.agreement.id, creditor); // counterparty first
      await notifiedCtx.agreementCtx.agreementService.signAgreement(created.agreement.id, debtor); // originator last
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

  /**
   * Blocker 2 (amendment PDF lifecycle): proves the required lifecycle end to end — original version
   * accepted -> snapshot frozen -> signed -> PDF #1 stored; amended version accepted -> NEW version
   * created -> NEW snapshot frozen (not overwriting V1's) -> signatures already complete by
   * construction -> PDF #2 stored — and that PDF #1 remains byte-for-byte untouched throughout. Builds
   * its own local context (rather than the shared `ctx`/`beforeEach` above) because those sign the
   * original agreement directly via AgreementService.signAgreement, bypassing SignatureService
   * entirely — no PDF is ever generated on that path, so it can't exercise PDF #1.
   */
  describe("Blocker 2: amendment PDF lifecycle", () => {
    async function setupSignedOriginalWithPdf() {
      const localCtx = createTestAmendmentService();
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorProfileId = randomUUID();
      localCtx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      localCtx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);
      // Distinct identities per version, set BEFORE each version's own snapshot freezes — proves PDF
      // #2 reads V2's own (later) snapshot, never V1's frozen-earlier one (tests 7/8).
      localCtx.agreementCtx.identitySource.set("personal", creditorProfileId, {
        displayName: "Creditor V1 Name",
        firstName: "Creditor V1",
        lastName: "Name",
        preferredEmail: "creditor-v1@example.com",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      });
      localCtx.agreementCtx.identitySource.set("personal", debtorProfileId, {
        displayName: "Debtor Name",
        firstName: "Debtor",
        lastName: "Name",
        preferredEmail: "debtor@example.com",
        city: "Dallas",
        state: "TX",
        postalCode: "75201",
        country: "US",
      });

      const created = await localCtx.agreementCtx.agreementService.createDraft({
        creatorUserId: debtorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      const agreementId = created.agreement.id;
      const originalVersionId = created.version.id;

      await localCtx.agreementCtx.agreementService.submitDraft(agreementId, creditorUserId);
      await localCtx.agreementCtx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
      await localCtx.agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });

      // Sign via SignatureService (not AgreementService.signAgreement directly) so generatePdf
      // actually runs — the real production path (AgreementDetail.tsx's Sign button -> POST
      // /api/agreements/sign -> SignatureService.sign).
      const creditorSession = randomUUID();
      const debtorSession = randomUUID();
      await grantStepUp({ mfaCredentials: localCtx.pdfCtx.mfaCredentials, stepUps: localCtx.pdfCtx.stepUps }, creditorUserId, creditorSession);
      await grantStepUp({ mfaCredentials: localCtx.pdfCtx.mfaCredentials, stepUps: localCtx.pdfCtx.stepUps }, debtorUserId, debtorSession);
      await localCtx.pdfCtx.signatureService.sign({
        agreementId,
        actingUserId: creditorUserId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: "v1",
        timezone: "America/New_York",
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      await localCtx.pdfCtx.signatureService.sign({
        agreementId,
        actingUserId: debtorUserId,
        actingSessionId: debtorSession,
        authMethod: "sms",
        consentVersion: "v1",
        timezone: "America/New_York",
        deviceInfo: null,
        ipAddress: "203.0.113.20",
      });

      return { localCtx, agreementId, originalVersionId, creditorUserId, debtorUserId, creditorProfileId, debtorProfileId };
    }

    it("tests 1,2,3,4,5,6,7,8,9,10,11 — full original+amendment PDF lifecycle", async () => {
      const { localCtx, agreementId, originalVersionId, creditorUserId, debtorUserId, creditorProfileId, debtorProfileId } =
        await setupSignedOriginalWithPdf();

      // Test 1: original executed version gets PDF #1.
      const pdf1Record = await localCtx.pdfCtx.agreementPdfs.findByVersion(originalVersionId);
      expect(pdf1Record).not.toBeNull();
      const pdf1BytesBefore = localCtx.pdfCtx.storage.read(pdf1Record!.storagePath)!;
      expect(hashPdfContent(pdf1BytesBefore)).toBe(pdf1Record!.documentHash);
      const pdf1TextBefore = extractPdfText(pdf1BytesBefore);
      expect(pdf1TextBefore).toContain("Creditor V1 Name");

      // Change the creditor's identity AFTER V1's snapshot/PDF exist, BEFORE the amendment applies —
      // proves V1's already-generated PDF never reflects a later identity change (immutability).
      localCtx.agreementCtx.identitySource.set("personal", creditorProfileId, {
        displayName: "Creditor V2 Name",
        firstName: "Creditor V2",
        lastName: "Name",
        preferredEmail: "creditor-v2@example.com",
        city: "Houston",
        state: "TX",
        postalCode: "77002",
        country: "US",
      });

      // Test 2: amendment creates Version 2.
      const amendment = await localCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "Lost overtime hours",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtorUserId,
      });
      await localCtx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
      await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
      const applied = await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });
      const v2Id = applied.resultingVersionId!;
      expect(v2Id).not.toBe(originalVersionId);

      // Test 3: Version 2 receives its own snapshot. Test 4: it does NOT overwrite Version 1's.
      const v1SnapshotAfter = localCtx.agreementCtx.snapshotRepo.rows.filter((r) => r.agreementVersionId === originalVersionId);
      const v2Snapshot = localCtx.agreementCtx.snapshotRepo.rows.filter((r) => r.agreementVersionId === v2Id);
      expect(v2Snapshot).toHaveLength(2);
      expect(v1SnapshotAfter.find((r) => r.role === "creditor")?.displayName).toBe("Creditor V1 Name"); // unchanged
      expect(v2Snapshot.find((r) => r.role === "creditor")?.displayName).toBe("Creditor V2 Name"); // the new one

      // Test 5: once Version 2 execution/signatures are complete, it gets PDF #2.
      const pdf2Record = await localCtx.pdfCtx.agreementPdfs.findByVersion(v2Id);
      expect(pdf2Record).not.toBeNull();
      expect(pdf2Record!.id).not.toBe(pdf1Record!.id);
      expect(pdf2Record!.storagePath).not.toBe(pdf1Record!.storagePath);

      // Test 6: PDF #1 remains unchanged.
      const pdf1BytesAfter = localCtx.pdfCtx.storage.read(pdf1Record!.storagePath)!;
      expect(pdf1BytesAfter).toEqual(pdf1BytesBefore);
      const pdf1RecordAfter = await localCtx.pdfCtx.agreementPdfs.findByVersion(originalVersionId);
      expect(pdf1RecordAfter).toEqual(pdf1Record);

      // Test 7: PDF #2 reflects Version 2 terms. Test 8: PDF #2 uses Version 2 identity snapshot.
      const pdf2Bytes = localCtx.pdfCtx.storage.read(pdf2Record!.storagePath)!;
      const pdf2Text = extractPdfText(pdf2Bytes);
      expect(pdf2Text).toContain("150.00 USD"); // the amended installment amount ($150.00 = 15,000 minor units)
      expect(pdf2Text).toContain("Creditor V2 Name");
      expect(pdf2Text).not.toContain("Creditor V1 Name"); // never the stale, pre-amendment identity

      // Test 9: PDF #2 contains no raw profile/user UUIDs.
      expect(pdf2Text).not.toContain(creditorProfileId);
      expect(pdf2Text).not.toContain(debtorProfileId);
      expect(pdf2Text).not.toContain(creditorUserId);
      expect(pdf2Text).not.toContain(debtorUserId);

      // Test 10: fetching/printing the current executed agreement selects the correct CURRENT
      // version's PDF (V2), not V1's, now that the agreement has moved on.
      const signedUrl = await localCtx.pdfCtx.signatureService.getSignedPdfUrl(agreementId, creditorUserId);
      expect(signedUrl).toContain(encodeURIComponent(pdf2Record!.storagePath));
      expect(signedUrl).not.toContain(encodeURIComponent(pdf1Record!.storagePath));

      // Test 11: the historical (V1) PDF remains independently retrievable via the same
      // version-scoped repository read a future version-history UI would use.
      const historicalPdf = await localCtx.pdfCtx.agreementPdfs.findByVersion(originalVersionId);
      expect(historicalPdf).toEqual(pdf1Record);
      expect(extractPdfText(localCtx.pdfCtx.storage.read(historicalPdf!.storagePath)!)).toContain("Creditor V1 Name");
    });

    it("is idempotent — calling generatePdfForAppliedAmendment again never regenerates or overwrites the stored PDF", async () => {
      const { localCtx, agreementId, creditorUserId, debtorUserId } = await setupSignedOriginalWithPdf();
      const amendment = await localCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "Lost overtime hours",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtorUserId,
      });
      await localCtx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
      await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
      const applied = await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });
      const v2Id = applied.resultingVersionId!;

      const first = await localCtx.pdfCtx.agreementPdfs.findByVersion(v2Id);
      // A defensive re-call (e.g. a retry) must never throw or produce a second row — the DB's own
      // agreement_pdf_version_unique index is a second guarantee of the same thing in production.
      await localCtx.pdfCtx.signatureService.generatePdfForAppliedAmendment(agreementId, v2Id, creditorUserId);
      const second = await localCtx.pdfCtx.agreementPdfs.findByVersion(v2Id);
      expect(second).toEqual(first);
    });

    it("a PDF-generation failure never fails the already-applied amendment (best-effort, non-blocking)", async () => {
      const { localCtx, agreementId, creditorUserId, debtorUserId } = await setupSignedOriginalWithPdf();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (localCtx.amendmentService as any).deps.pdfGenerator = {
        generatePdfForAppliedAmendment: async () => {
          throw new Error("simulated_pdf_outage");
        },
      };
      const amendment = await localCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "Lost overtime hours",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtorUserId,
      });
      await localCtx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
      await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
      const applied = await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });
      expect(applied.status).toBe("applied"); // the amendment itself is unaffected by the PDF failure
      expect(applied.resultingVersionId).toBeTruthy();
    });

    /**
     * Blocker 1 (amendment PDF failure must not be silent): the full recovery story, points 1-8.
     */
    it("full recovery: a failed Version 2 PDF generation is detectable, Version 1 is untouched, and a later retry (via getSignedPdfUrl's lazy regeneration) succeeds without duplicating", async () => {
      const { localCtx, agreementId, originalVersionId, creditorUserId, debtorUserId } = await setupSignedOriginalWithPdf();

      // Point 4 baseline: capture Version 1's PDF before touching anything.
      const pdf1Before = await localCtx.pdfCtx.agreementPdfs.findByVersion(originalVersionId);
      const pdf1BytesBefore = localCtx.pdfCtx.storage.read(pdf1Before!.storagePath)!;

      // Simulate PDF generation failing exactly once, at the moment the amendment applies.
      const realPdfGenerator = localCtx.pdfCtx.signatureService;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (localCtx.amendmentService as any).deps.pdfGenerator = {
        generatePdfForAppliedAmendment: async () => {
          throw new Error("simulated_pdf_outage");
        },
      };

      // Point 1: the amendment applies successfully regardless.
      const amendment = await localCtx.amendmentService.proposeAmendment({
        agreementId,
        changeType: "reduced_installment",
        reason: "Lost overtime hours",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
        actingUserId: debtorUserId,
      });
      await localCtx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
      await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId });
      const applied = await localCtx.amendmentService.signAmendment({ amendmentId: amendment.id, actingUserId: debtorUserId });
      expect(applied.status).toBe("applied");
      const v2Id = applied.resultingVersionId!;

      // Point 2: Version 2's identity snapshot exists and is immutable regardless of the PDF failure
      // — freezeSnapshot runs (and succeeds) BEFORE the pdfGenerator call, independently of it.
      const v2Snapshot = localCtx.agreementCtx.snapshotRepo.rows.filter((r) => r.agreementVersionId === v2Id);
      expect(v2Snapshot).toHaveLength(2);

      // Point 3 (already happened above) / Point 5: Version 2 is detectably missing its PDF, using
      // only EXISTING state — no new column. Both the raw repository read and the dedicated
      // getDocumentStatus read agree.
      expect(await localCtx.pdfCtx.agreementPdfs.findByVersion(v2Id)).toBeNull();
      const v2Version = await localCtx.agreementCtx.versions.findById(v2Id);
      expect(v2Version?.signedAt).not.toBeNull(); // fully executed...
      const statusWhileMissing = await realPdfGenerator.getDocumentStatus(agreementId, creditorUserId);
      expect(statusWhileMissing).toEqual({ agreementVersionId: v2Id, isFullyExecuted: true, hasStoredPdf: false }); // ...but no PDF

      // Point 4: Version 1's PDF is completely untouched by the failure.
      const pdf1After = await localCtx.pdfCtx.agreementPdfs.findByVersion(originalVersionId);
      expect(pdf1After).toEqual(pdf1Before);
      expect(localCtx.pdfCtx.storage.read(pdf1After!.storagePath)).toEqual(pdf1BytesBefore);

      // Point 6/8: retrying via the real, non-throwing SignatureService (mirroring what the "View
      // signed PDF" action already does automatically) succeeds and resolves to Version 2.
      const signedUrl = await realPdfGenerator.getSignedPdfUrl(agreementId, creditorUserId);
      const v2PdfAfterRetry = await localCtx.pdfCtx.agreementPdfs.findByVersion(v2Id);
      expect(v2PdfAfterRetry).not.toBeNull();
      expect(signedUrl).toContain(encodeURIComponent(v2PdfAfterRetry!.storagePath));

      const statusAfterRetry = await realPdfGenerator.getDocumentStatus(agreementId, creditorUserId);
      expect(statusAfterRetry).toEqual({ agreementVersionId: v2Id, isFullyExecuted: true, hasStoredPdf: true });

      // Point 7: a second, redundant retry never duplicates — still exactly one PDF row for Version 2.
      await realPdfGenerator.ensurePdfForVersion(agreementId, v2Id, creditorUserId);
      const v2PdfAfterSecondRetry = await localCtx.pdfCtx.agreementPdfs.findByVersion(v2Id);
      expect(v2PdfAfterSecondRetry).toEqual(v2PdfAfterRetry);

      // Version 1's PDF is STILL untouched after all of the above.
      expect(await localCtx.pdfCtx.agreementPdfs.findByVersion(originalVersionId)).toEqual(pdf1Before);
    });
  });
});
