import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementVersionsHandler } from "./route";

/**
 * PRSprint 11 (docs/prsprints/PRSPRINT_11_AGREEMENT_VERSIONING_AMENDMENTS_MUTUAL_APPROVAL.md):
 * route-level cross-tenant/IDOR coverage for GET /api/agreements/versions, mirroring
 * /api/agreements/detail/route.test.ts's identical pattern.
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
    firstPaymentDate: "2026-02-01",
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
    ? `http://localhost/api/agreements/versions?agreementId=${agreementId}`
    : "http://localhost/api/agreements/versions";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/agreements/versions", () => {
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
      email: "versions-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "versions-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "versions-stranger@example.com",
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
      "agreement_versions",
      createAgreementVersionsHandler(authCtx.authService, agreementCtx.agreementService),
    );
  }

  it("lets the creditor party list the version history, oldest first", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { versions: { versionNumber: number; isOriginal: boolean }[] };
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]!.versionNumber).toBe(1);
    expect(body.versions[0]!.isOriginal).toBe(true);
  });

  it("lets the debtor party list the version history", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, debtorToken));
    expect(response.status).toBe(200);
  });

  it("rejects a cross-tenant IDOR attempt: an authenticated stranger cannot list another agreement's version history", async () => {
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
