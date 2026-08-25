import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementDetailHandler } from "./route";

/**
 * PRSprint 02 (docs/prsprints/PRSPRINT_02_RLS_CROSS_TENANT_SECURITY.md): route-level cross-tenant/
 * IDOR coverage for GET /api/agreements/detail. AgreementService.getAgreement already has unit-level
 * stranger-rejection coverage (src/lib/agreements/agreementService.test.ts's "unauthorized access"
 * suite), but nothing previously exercised the actual route handler end-to-end — the boundary a
 * wiring regression (wrong parameter order, a dropped userId, a bypassed authorization call) would
 * actually break. This proves the HTTP-level 401/403 behavior directly, following the same
 * create*Handler + in-memory-service pattern as src/app/api/dashboard/business/route.test.ts.
 */
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

function getWithCookie(agreementId: string | null, token?: string) {
  const url = agreementId
    ? `http://localhost/api/agreements/detail?id=${agreementId}`
    : "http://localhost/api/agreements/detail";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/agreements/detail", () => {
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
      email: "detail-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "detail-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "detail-stranger@example.com",
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
  });

  function handlerFor() {
    return withErrorHandling(
      "agreement_detail",
      createAgreementDetailHandler(authCtx.authService, agreementCtx.agreementService),
    );
  }

  it("lets the creditor party fetch the agreement", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(agreementId);
  });

  it("lets the debtor party fetch the agreement", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, debtorToken));
    expect(response.status).toBe(200);
  });

  it("rejects a cross-tenant IDOR attempt: an authenticated stranger cannot fetch someone else's agreement by id", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie(agreementId));
    expect(response.status).toBe(401);
  });

  it("rejects a tampered/nonexistent agreement id with a non-200, without leaking existence of other agreements", async () => {
    const response = await handlerFor()(getWithCookie(randomUUID(), creditorToken));
    expect(response.status).not.toBe(200);
  });
});
