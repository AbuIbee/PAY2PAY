import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "./agreementService";
import { createTestAgreementCancellationService } from "./agreementCancellationTestFakes";

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

/**
 * Mutual cancellation (mandatory command): proves the whole request -> accept/decline lifecycle for
 * an already-ACTIVE agreement — distinct from AgreementService.cancelAgreement's own pre-signature
 * unilateral withdraw (covered by agreementService.test.ts and left completely untouched here).
 */
describe("AgreementCancellationService", () => {
  let ctx: ReturnType<typeof createTestAgreementCancellationService>;
  let creditorUserId: string;
  let debtorUserId: string;
  let agreementId: string;

  beforeEach(async () => {
    ctx = createTestAgreementCancellationService();
    creditorUserId = randomUUID();
    debtorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    ctx.notifyCtx.contacts.set(creditorUserId, "creditor@example.com");
    ctx.notifyCtx.contacts.set(debtorUserId, "debtor@example.com");

    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
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

  it("either party may request cancellation on an active agreement, and the agreement stays active while it's pending", async () => {
    const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
    expect(request.status).toBe("pending");
    expect(request.requestedByPartyRole).toBe("debtor");

    const { agreement } = await ctx.agreementCtx.agreementService.getAgreement(agreementId, creditorUserId);
    expect(agreement.status).not.toBe("mutually_canceled");
    expect(["first_payment_pending", "active", "past_due"]).toContain(agreement.status);
  });

  it("a reason is required", async () => {
    await expect(ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "   " })).rejects.toThrow(ValidationError);
  });

  it("rejects a second request while one is already pending", async () => {
    await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "First request" });
    await expect(
      ctx.cancellationService.requestCancellation({ agreementId, actingUserId: creditorUserId, reason: "Second request" }),
    ).rejects.toThrow(ValidationError);
  });

  it("notifies the counterparty (not the requester) when a cancellation is requested", async () => {
    await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
    const creditorNotifications = await ctx.notifyCtx.notificationService.listGroupedForUser(creditorUserId);
    const debtorNotifications = await ctx.notifyCtx.notificationService.listGroupedForUser(debtorUserId);
    expect(creditorNotifications.some((n) => n.notificationType === "agreement_cancellation_requested")).toBe(true);
    expect(debtorNotifications.some((n) => n.notificationType === "agreement_cancellation_requested")).toBe(false);
  });

  it("the requester cannot decide their own request", async () => {
    const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
    await expect(
      ctx.cancellationService.decideCancellation({ cancellationRequestId: request.id, actingUserId: debtorUserId, decision: "accept" }),
    ).rejects.toThrow(ForbiddenError);
  });

  describe("accept path", () => {
    it("accepting transitions the agreement to mutually_canceled and notifies the requester", async () => {
      const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
      const decided = await ctx.cancellationService.decideCancellation({ cancellationRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });
      expect(decided.status).toBe("accepted");

      const { agreement } = await ctx.agreementCtx.agreementService.getAgreement(agreementId, creditorUserId);
      expect(agreement.status).toBe("mutually_canceled");

      const debtorNotifications = await ctx.notifyCtx.notificationService.listGroupedForUser(debtorUserId);
      const decision = debtorNotifications.find((n) => n.notificationType === "agreement_cancellation_decided");
      expect(decision).toBeTruthy();
      expect(decision?.payload).toMatchObject({ decision: "accepted" });
    });
  });

  describe("decline path", () => {
    it("declining leaves the agreement untouched and records the rejection reason", async () => {
      const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
      const decided = await ctx.cancellationService.decideCancellation({
        cancellationRequestId: request.id,
        actingUserId: creditorUserId,
        decision: "reject",
        rejectedReason: "We agreed to keep this going",
      });
      expect(decided.status).toBe("rejected");
      expect(decided.rejectedReason).toBe("We agreed to keep this going");

      const { agreement } = await ctx.agreementCtx.agreementService.getAgreement(agreementId, creditorUserId);
      expect(agreement.status).not.toBe("mutually_canceled");
      expect(["first_payment_pending", "active", "past_due"]).toContain(agreement.status);

      const debtorNotifications = await ctx.notifyCtx.notificationService.listGroupedForUser(debtorUserId);
      const decision = debtorNotifications.find((n) => n.notificationType === "agreement_cancellation_decided");
      expect(decision?.payload).toMatchObject({ decision: "rejected" });
    });

    it("a new request can be made again after a decline (no longer 'already pending')", async () => {
      const first = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
      await ctx.cancellationService.decideCancellation({ cancellationRequestId: first.id, actingUserId: creditorUserId, decision: "reject" });

      const second = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: creditorUserId, reason: "Actually, let's cancel" });
      expect(second.status).toBe("pending");
    });
  });

  it("cannot request cancellation before the agreement is active (still pre-signature)", async () => {
    const creditorProfileId2 = randomUUID();
    const debtorProfileId2 = randomUUID();
    const creditorUserId2 = randomUUID();
    const debtorUserId2 = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId2, creditorUserId2);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId2, debtorUserId2);
    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId2,
      creditor: { kind: "personal", id: creditorProfileId2 },
      debtor: { kind: "personal", id: debtorProfileId2 },
      ...baseTerms(),
    });
    await expect(
      ctx.cancellationService.requestCancellation({ agreementId: created.agreement.id, actingUserId: debtorUserId2, reason: "Too early" }),
    ).rejects.toThrow(ValidationError);
  });

  it("cannot decide a request twice", async () => {
    const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
    await ctx.cancellationService.decideCancellation({ cancellationRequestId: request.id, actingUserId: creditorUserId, decision: "accept" });
    await expect(
      ctx.cancellationService.decideCancellation({ cancellationRequestId: request.id, actingUserId: creditorUserId, decision: "accept" }),
    ).rejects.toThrow(ValidationError);
  });
});
