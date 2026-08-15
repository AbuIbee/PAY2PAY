import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createPaymentsByAgreementHandler } from "./route";

/**
 * PRSprint 02 (docs/prsprints/PRSPRINT_02_RLS_CROSS_TENANT_SECURITY.md): route-level cross-tenant/
 * IDOR coverage for GET /api/payments/by-agreement.
 *
 * This route is the one call site of PaymentService.listByAgreementId, a method that deliberately
 * takes no actingUserId (see its own doc comment in src/lib/payments/paymentService.ts) and instead
 * trusts the *caller* to have already authorized the agreement via AgreementService.getAgreement
 * first. That is a correct but structurally fragile split — nothing at compile time or in
 * PaymentService's own tests stops a future edit here from calling listByAgreementId before (or
 * without) the getAgreement authorization check. This test exercises the actual route handler so a
 * regression in that ordering — the exact "trust the caller" landmine the PRSprint 02 audit
 * flagged — fails CI instead of shipping.
 */
function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "b2b_invoice",
    description: "Outstanding invoice",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: "2026-02-01",
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

function getWithCookie(agreementId: string | null, token?: string) {
  const url = agreementId
    ? `http://localhost/api/payments/by-agreement?agreementId=${agreementId}`
    : "http://localhost/api/payments/by-agreement";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/payments/by-agreement", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let paymentCtx: ReturnType<typeof createTestPaymentService>;
  let agreementId: string;
  let otherAgreementId: string;
  let creditorToken: string;
  let strangerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    agreementCtx = createTestAgreementService();
    paymentCtx = createTestPaymentService();

    const creditor = await authCtx.authService.signup({
      email: "by-agreement-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "by-agreement-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "by-agreement-stranger@example.com",
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

    // A second, unrelated agreement — its payment must never leak into the first agreement's list.
    const otherCreditorProfileId = randomUUID();
    const otherDebtorProfileId = randomUUID();
    agreementCtx.profileOwners.set("personal", otherCreditorProfileId, stranger.user.id);
    agreementCtx.profileOwners.set("personal", otherDebtorProfileId, randomUUID());
    const otherCreated = await agreementCtx.agreementService.createDraft({
      creatorUserId: stranger.user.id,
      creditor: { kind: "personal", id: otherCreditorProfileId },
      debtor: { kind: "personal", id: otherDebtorProfileId },
      ...baseTerms({ description: "Unrelated invoice" }),
    });
    otherAgreementId = otherCreated.agreement.id;

    await paymentCtx.payments.insertPending({
      idempotencyKey: `by-agreement-route-test-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtorProfileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditorProfileId,
      amountMinorUnits: 20_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
    });
    await paymentCtx.payments.insertPending({
      idempotencyKey: `by-agreement-route-test-other-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: randomUUID(),
      recipientProfileKind: "personal",
      recipientProfileId: randomUUID(),
      amountMinorUnits: 45_000,
      currency: "USD",
      agreementId: otherAgreementId,
      providerName: "sandbox_mock",
    });
  });

  function handlerFor() {
    return withErrorHandling(
      "payments_by_agreement",
      createPaymentsByAgreementHandler(authCtx.authService, agreementCtx.agreementService, paymentCtx.paymentService),
    );
  }

  it("lets an agreement party list only that agreement's payments, never another agreement's", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { payments: Array<{ agreementId: string | null; amountMinorUnits: number }> };
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]?.agreementId).toBe(agreementId);
    expect(body.payments.some((p) => p.amountMinorUnits === 45_000)).toBe(false);
  });

  it("rejects a cross-tenant IDOR attempt: an authenticated stranger cannot list another agreement's payments", async () => {
    const response = await handlerFor()(getWithCookie(agreementId, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie(agreementId));
    expect(response.status).toBe(401);
  });
});
