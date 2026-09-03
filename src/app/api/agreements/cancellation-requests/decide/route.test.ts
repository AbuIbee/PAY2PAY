import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementCancellationService } from "@/lib/agreements/agreementCancellationTestFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementCancellationDecideHandler } from "./route";

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
    hardshipRules: "Borrower may request hardship relief.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

describe("POST /api/agreements/cancellation-requests/decide", () => {
  let ctx: ReturnType<typeof createTestAgreementCancellationService>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementId: string;
  let debtorUserId: string;
  let creditorToken: string;

  beforeEach(async () => {
    ctx = createTestAgreementCancellationService();
    authCtx = createTestAuthService();

    const creditor = await authCtx.authService.signup({ accountType: "personal", identity: TEST_SIGNUP_IDENTITY, inviteCode: null, email: `creditor-${randomUUID()}@example.com`, password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    const debtor = await authCtx.authService.signup({ accountType: "personal", identity: TEST_SIGNUP_IDENTITY, inviteCode: null, email: `debtor-${randomUUID()}@example.com`, password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    creditorToken = creditor.token;
    debtorUserId = debtor.user.id;

    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditor.user.id);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtor.user.id);

    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtor.user.id,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    agreementId = created.agreement.id;
    await ctx.agreementCtx.agreementService.submitDraft(agreementId, creditor.user.id);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(agreementId, debtor.user.id);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditor.user.id, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, creditor.user.id);
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, debtor.user.id);
  });

  function handler() {
    return withErrorHandling("agreement_cancellation_decide", createAgreementCancellationDecideHandler(authCtx.authService, ctx.cancellationService));
  }
  function post(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/agreements/cancellation-requests/decide", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("accepting transitions the agreement to mutually_canceled", async () => {
    const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
    const response = await handler()(post({ cancellationRequestId: request.id, decision: "accept" }, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("accepted");

    const { agreement } = await ctx.agreementCtx.agreementService.getAgreement(agreementId, debtorUserId);
    expect(agreement.status).toBe("mutually_canceled");
  });

  it("rejecting leaves the agreement active and records the reason", async () => {
    const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
    const response = await handler()(post({ cancellationRequestId: request.id, decision: "reject", rejectedReason: "We want to keep going" }, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; rejectedReason: string | null };
    expect(body.status).toBe("rejected");
    expect(body.rejectedReason).toBe("We want to keep going");

    const { agreement } = await ctx.agreementCtx.agreementService.getAgreement(agreementId, debtorUserId);
    expect(agreement.status).not.toBe("mutually_canceled");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const request = await ctx.cancellationService.requestCancellation({ agreementId, actingUserId: debtorUserId, reason: "No longer needed" });
    const response = await handler()(post({ cancellationRequestId: request.id, decision: "accept" }));
    expect(response.status).toBe(401);
  });
});
