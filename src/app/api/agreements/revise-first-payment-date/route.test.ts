import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementReviseFirstPaymentDateHandler } from "./route";

/**
 * Agreement workflow remediation (Problem 2) — route-level coverage for the resolution path a
 * ScheduleRevisionRequiredError is supposed to lead to. Mirrors detail/route.test.ts's exact
 * create*Handler + in-memory-service pattern.
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
    firstPaymentDate: "2020-01-01",
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
  return new NextRequest("http://localhost/api/agreements/revise-first-payment-date", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
  });
}

describe("POST /api/agreements/revise-first-payment-date", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let agreementId: string;
  let creditorToken: string;
  let strangerToken: string;
  const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  beforeEach(async () => {
    authCtx = createTestAuthService();
    agreementCtx = createTestAgreementService();

    const creditor = await authCtx.authService.signup({
      email: "revise-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "revise-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "revise-stranger@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    creditorToken = creditor.token;
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
    await agreementCtx.agreementService.acknowledgeDebt(agreementId, debtor.user.id);
    await agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditor.user.id, decision: "accept" });
  });

  function handlerFor() {
    return withErrorHandling(
      "agreement_revise_first_payment_date",
      createAgreementReviseFirstPaymentDateHandler(authCtx.authService, agreementCtx.agreementService),
    );
  }

  it("lets a real party revise the stale schedule end to end (200), unblocking signing", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newFirstPaymentDate: futureDate }, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; firstPaymentDate: string };
    expect(body.firstPaymentDate).toBe(futureDate);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newFirstPaymentDate: futureDate }));
    expect(response.status).toBe(401);
  });

  it("rejects a cross-tenant stranger attempting to revise someone else's agreement (403)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newFirstPaymentDate: futureDate }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects a malformed date before ever reaching AgreementService (400)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newFirstPaymentDate: "not-a-date" }, creditorToken));
    expect(response.status).toBe(400);
  });

  it("rejects a new date that is itself still in the past (400)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newFirstPaymentDate: "2020-06-01" }, creditorToken));
    expect(response.status).toBe(400);
  });
});
