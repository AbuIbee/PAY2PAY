import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementCancelHandler } from "./route";

/** Agreement Lifecycle V2 UAT (Defect 3 — Cancel/Withdraw a sent, unexecuted agreement): route-level coverage. */
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

function postWithCookie(body: unknown, token?: string) {
  return new NextRequest("http://localhost/api/agreements/cancel", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
  });
}

describe("POST /api/agreements/cancel", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let agreementId: string;
  let creditorToken: string;
  let debtorToken: string;
  let strangerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    agreementCtx = createTestAgreementService();

    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "cancel-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "cancel-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "cancel-stranger@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    creditorToken = creditor.token;
    debtorToken = debtor.token;
    strangerToken = stranger.token;

    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    agreementCtx.profileOwners.set("personal", creditorProfileId, creditor.user.id);
    agreementCtx.profileOwners.set("personal", debtorProfileId, debtor.user.id);

    const created = await agreementCtx.agreementService.createDraft({
      creatorUserId: creditor.user.id,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    agreementId = created.agreement.id;
    await agreementCtx.agreementService.submitDraft(agreementId, creditor.user.id);
  });

  function handlerFor() {
    return withErrorHandling("agreement_cancel", createAgreementCancelHandler(authCtx.authService, agreementCtx.agreementService));
  }

  it("lets either party cancel a sent, unexecuted agreement (200)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, reason: "Changed my mind." }, debtorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("mutually_canceled");
  });

  it("rejects an unauthenticated request (401)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, reason: "test" }));
    expect(response.status).toBe(401);
  });

  it("rejects a stranger with no relationship to either party (403)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, reason: "test" }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects a missing/empty reason (400)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, reason: "" }, creditorToken));
    expect(response.status).toBe(400);
  });

});
