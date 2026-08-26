import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import {
  AgreementProgressService,
  type AgreementBalanceReader,
  type AgreementCancellationInfo,
  type AgreementCancellationReader,
  type AgreementInstallmentStatusReader,
  type AgreementMandateReader,
  type AgreementPaymentAttemptsReader,
  type RelationshipPaymentMethodReader,
} from "@/lib/agreements/agreementProgressService";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementProgressHandler } from "./route";

class FakePaymentMethods implements RelationshipPaymentMethodReader {
  async getRelationshipAccounts() {
    return [];
  }
}
class FakeCancellation implements AgreementCancellationReader {
  async getCancellationInfo(): Promise<AgreementCancellationInfo | null> {
    return null;
  }
}
class FakeMandates implements AgreementMandateReader {
  async isActiveForAgreement() {
    return false;
  }
}
class FakeInstallments implements AgreementInstallmentStatusReader {
  async listForAgreement() {
    return [];
  }
}
class FakePaymentAttempts implements AgreementPaymentAttemptsReader {
  async listByAgreementId() {
    return [];
  }
}
class FakeBalance implements AgreementBalanceReader {
  async getAgreementBalance(): Promise<never> {
    throw new Error("no balance in this test");
  }
}

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
  const url = agreementId ? `http://localhost/api/agreements/progress?id=${agreementId}` : "http://localhost/api/agreements/progress";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/agreements/progress", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let progressService: AgreementProgressService;
  let agreementId: string;
  let creditorToken: string;
  let strangerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    agreementCtx = createTestAgreementService();
    progressService = new AgreementProgressService({
      agreementService: agreementCtx.agreementService,
      relationshipPaymentMethods: new FakePaymentMethods(),
      cancellation: new FakeCancellation(),
      mandates: new FakeMandates(),
      installments: new FakeInstallments(),
      paymentAttempts: new FakePaymentAttempts(),
      balance: new FakeBalance(),
    });

    const creditor = await authCtx.authService.signup({
      email: "progress-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "progress-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "progress-stranger@example.com",
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
  });

  function handlerFor() {
    return withErrorHandling("agreement_progress", createAgreementProgressHandler(authCtx.authService, progressService));
  }

  it("returns the full step list for a real party (200)", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { steps: unknown[]; myRole: string; primaryAction: unknown };
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBeGreaterThan(0);
    expect(body.myRole).toBe("creditor");
    expect(body.primaryAction).toBeTruthy();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie(agreementId));
    expect(response.status).toBe(401);
  });

  it("rejects a cross-tenant stranger — this is UX data, but still never leaks another party's agreement state", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects a request missing the id parameter (400)", async () => {
    const response = await handlerFor()(getWithCookie(null, creditorToken));
    expect(response.status).toBe(400);
  });
});
