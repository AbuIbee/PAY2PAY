import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementCancellationService } from "@/lib/agreements/agreementCancellationTestFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementCancellationListHandler, createAgreementCancellationRequestHandler } from "./route";

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

describe("POST/GET /api/agreements/cancellation-requests", () => {
  let ctx: ReturnType<typeof createTestAgreementCancellationService>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementId: string;
  let debtorToken: string;
  let creditorToken: string;

  beforeEach(async () => {
    ctx = createTestAgreementCancellationService();
    authCtx = createTestAuthService();

    const creditor = await authCtx.authService.signup({ accountType: "personal", identity: TEST_SIGNUP_IDENTITY, inviteCode: null, email: `creditor-${randomUUID()}@example.com`, password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    const debtor = await authCtx.authService.signup({ accountType: "personal", identity: TEST_SIGNUP_IDENTITY, inviteCode: null, email: `debtor-${randomUUID()}@example.com`, password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    creditorToken = creditor.token;
    debtorToken = debtor.token;

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

  function postHandler() {
    return withErrorHandling("agreement_cancellation_request", createAgreementCancellationRequestHandler(authCtx.authService, ctx.cancellationService));
  }
  function getHandler() {
    return withErrorHandling("agreement_cancellation_list", createAgreementCancellationListHandler(authCtx.authService, ctx.cancellationService));
  }
  function post(body: unknown, token?: string) {
    return new NextRequest("http://localhost/api/agreements/cancellation-requests", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }
  function get(agreementIdParam: string, token?: string) {
    return new NextRequest(`http://localhost/api/agreements/cancellation-requests?agreementId=${agreementIdParam}`, {
      method: "GET",
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("creates a pending cancellation request for the debtor", async () => {
    const response = await postHandler()(post({ agreementId, reason: "No longer needed" }, debtorToken));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string; requestedByPartyRole: string };
    expect(body.status).toBe("pending");
    expect(body.requestedByPartyRole).toBe("debtor");
  });

  it("rejects a request missing a reason", async () => {
    const response = await postHandler()(post({ agreementId, reason: "" }, debtorToken));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await postHandler()(post({ agreementId, reason: "No longer needed" }));
    expect(response.status).toBe(401);
  });

  it("lists cancellation requests for either party", async () => {
    await postHandler()(post({ agreementId, reason: "No longer needed" }, debtorToken));
    const response = await getHandler()(get(agreementId, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { requests: Array<{ agreementId: string }> };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.agreementId).toBe(agreementId);
  });
});
