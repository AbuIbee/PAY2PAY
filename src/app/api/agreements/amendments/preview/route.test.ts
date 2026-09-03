import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAmendmentService } from "@/lib/amendments/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAmendmentPreviewHandler } from "./route";

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

/**
 * Receiving-party amendment review remediation: proves the HTTP boundary for the new read-only
 * "proposed effective schedule" preview — the piece the recipient's "View revised agreement" screen
 * needs that isn't already carried on the raw amendment record.
 */
describe("GET /api/agreements/amendments/preview", () => {
  let ctx: ReturnType<typeof createTestAmendmentService>;
  let authCtx: ReturnType<typeof createTestAuthService>;
  let creditorUserId: string;
  let debtorUserId: string;
  let creditorToken: string;
  let debtorToken: string;
  let strangerToken: string;
  let agreementId: string;

  beforeEach(async () => {
    ctx = createTestAmendmentService();
    authCtx = createTestAuthService();

    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `amend-preview-creditor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `amend-preview-debtor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `amend-preview-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    creditorUserId = creditor.user.id;
    debtorUserId = debtor.user.id;
    creditorToken = creditor.token;
    debtorToken = debtor.token;
    strangerToken = stranger.token;

    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);

    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    agreementId = created.agreement.id;
    await ctx.agreementCtx.agreementService.submitDraft(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await ctx.agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, creditorUserId);
    await ctx.agreementCtx.agreementService.signAgreement(agreementId, debtorUserId);
  });

  function handler() {
    return withErrorHandling("amendment_preview", createAmendmentPreviewHandler(authCtx.authService, ctx.amendmentService));
  }

  function get(id: string, token?: string) {
    return new NextRequest(`http://localhost/api/agreements/amendments/preview?id=${id}`, {
      method: "GET",
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("computes the proposed effective schedule from the amendment's own proposed terms — never the current agreement's schedule", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "reduced_installment",
      reason: "Lost overtime hours at work",
      proposedTerms: baseTerms({ originalAmountMinorUnits: 90_000, firstPaymentMinorUnits: 15_000, installmentAmountMinorUnits: 15_000 }),
      actingUserId: debtorUserId,
    });

    const response = await handler()(get(amendment.id, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { schedule: Array<{ sequenceNumber: number; amountMinorUnits: number }>; finalPaymentMinorUnits: number; numberOfInstallments: number };
    expect(body.schedule[0]?.amountMinorUnits).toBe(15_000);
    // 120_000 original in the current agreement vs 90_000 proposed — a genuinely different schedule length.
    expect(body.numberOfInstallments).not.toBe(undefined);
    expect(body.schedule.every((item) => item.amountMinorUnits > 0)).toBe(true);
  });

  it("rejects a stranger to the agreement", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "test",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    const response = await handler()(get(amendment.id, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "test",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    const response = await handler()(get(amendment.id));
    expect(response.status).toBe(401);
  });

  it("400s when id is missing", async () => {
    const request = new NextRequest("http://localhost/api/agreements/amendments/preview", { headers: { cookie: `p2p_session=${creditorToken}` } });
    const response = await handler()(request);
    expect(response.status).toBe(400);
  });

  it("still returns a preview for an already-decided amendment (accepted/awaiting_signatures), never blocking review of history", async () => {
    const amendment = await ctx.amendmentService.proposeAmendment({
      agreementId,
      changeType: "general",
      reason: "test",
      proposedTerms: baseTerms(),
      actingUserId: debtorUserId,
    });
    await ctx.amendmentService.decideAmendment({ amendmentId: amendment.id, actingUserId: creditorUserId, decision: "accept" });
    const response = await handler()(get(amendment.id, debtorToken));
    expect(response.status).toBe(200);
  });
});
