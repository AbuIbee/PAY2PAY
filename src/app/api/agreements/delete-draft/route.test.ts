import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementDeleteDraftHandler } from "./route";

/** Agreement Lifecycle V2 UAT (Defect 3 — Delete Draft): route-level coverage. */
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
  return new NextRequest("http://localhost/api/agreements/delete-draft", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
  });
}

describe("POST /api/agreements/delete-draft", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let agreementId: string;
  let creditorToken: string;
  let debtorToken: string;
  let creditorUserId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    agreementCtx = createTestAgreementService();

    const creditor = await authCtx.authService.signup({
      email: "delete-draft-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "delete-draft-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    creditorToken = creditor.token;
    debtorToken = debtor.token;
    creditorUserId = creditor.user.id;

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
  });

  function handlerFor() {
    return withErrorHandling("agreement_delete_draft", createAgreementDeleteDraftHandler(authCtx.authService, agreementCtx.agreementService));
  }

  it("lets the originator delete their own unsent draft (200)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId }, creditorToken));
    expect(response.status).toBe(200);
    expect(await agreementCtx.agreements.findById(agreementId)).toBeNull();
  });

  it("rejects the non-originator counterparty (403) — the draft is not deleted", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId }, debtorToken));
    expect(response.status).toBe(403);
    expect(await agreementCtx.agreements.findById(agreementId)).not.toBeNull();
  });

  it("rejects an unauthenticated request (401)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId }));
    expect(response.status).toBe(401);
  });

  it("rejects deleting once the draft has already been submitted (400)", async () => {
    await agreementCtx.agreementService.submitDraft(agreementId, creditorUserId);
    const response = await handlerFor()(postWithCookie({ agreementId }, creditorToken));
    expect(response.status).toBe(400);
  });

  it("rejects a missing agreementId (400)", async () => {
    const response = await handlerFor()(postWithCookie({}, creditorToken));
    expect(response.status).toBe(400);
  });
});
