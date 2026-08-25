import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementReviseTermsHandler } from "./route";

/**
 * Agreement Lifecycle V2 (Part 1, Phase 3/4) — route-level coverage for the shared pre-signature
 * revision path. Exercises the debtor side specifically: before this route existed, only the
 * creditor had a "propose different terms" action (via /api/agreements/decide's "counter" branch) —
 * the debtor at awaiting_debtor_acknowledgment could only acknowledge or do nothing.
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

function postWithCookie(body: unknown, token?: string) {
  return new NextRequest("http://localhost/api/agreements/revise-terms", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
  });
}

describe("POST /api/agreements/revise-terms", () => {
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
      email: "revise-terms-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "revise-terms-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "revise-terms-stranger@example.com",
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
    // Left at awaiting_debtor_acknowledgment — the debtor's turn.
  });

  function handlerFor() {
    return withErrorHandling("agreement_revise_terms", createAgreementReviseTermsHandler(authCtx.authService, agreementCtx.agreementService));
  }

  it("lets the debtor propose revised terms at their own turn (200), creating a new version and flipping the turn back to the creditor", async () => {
    const response = await handlerFor()(
      postWithCookie(
        { agreementId, newTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }), reason: "I can only afford smaller installments." },
        debtorToken,
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; versionNumber: number };
    expect(body.status).toBe("awaiting_creditor_acceptance");
    expect(body.versionNumber).toBe(2);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newTerms: baseTerms(), reason: "test" }));
    expect(response.status).toBe(401);
  });

  it("rejects a cross-tenant stranger (403)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newTerms: baseTerms(), reason: "test" }, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects the creditor attempting to revise when it isn't their turn (not 200) — server-authoritative turn enforcement", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newTerms: baseTerms(), reason: "test" }, creditorToken));
    expect(response.status).not.toBe(200);
  });

  it("rejects a missing reason before ever reaching AgreementService (400)", async () => {
    const response = await handlerFor()(postWithCookie({ agreementId, newTerms: baseTerms(), reason: "" }, debtorToken));
    expect(response.status).toBe(400);
  });
});
