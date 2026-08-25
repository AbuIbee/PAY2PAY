import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestSignatureService, grantStepUp, markFullyVerified, seedPersonalParty } from "@/lib/signatures/testFakes";
import { createAgreementPdfHandler } from "./route";

/**
 * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md) —
 * route-level coverage for the executed-PDF retrieval endpoint: no session (401), and — the
 * requirement #15/#28 concern this test exists specifically to prove — an authenticated stranger to
 * the agreement cannot retrieve its signed PDF through the real HTTP route (403), even with a
 * genuine session and the correct agreement id.
 */
describe("GET /api/agreements/pdf", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let sigCtx: ReturnType<typeof createTestSignatureService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    sigCtx = createTestSignatureService();
  });

  function handler() {
    return withErrorHandling("agreement_pdf", createAgreementPdfHandler(authCtx.authService, sigCtx.signatureService));
  }

  function getWithCookie(id: string, sessionToken?: string) {
    return new NextRequest(`http://localhost/api/agreements/pdf?id=${id}`, {
      headers: sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {},
    });
  }

  it("rejects a request with no session (401)", async () => {
    const response = await handler()(getWithCookie("00000000-0000-0000-0000-000000000000"));
    expect(response.status).toBe(401);
  });

  it("a real, authenticated stranger to the agreement cannot retrieve its signed PDF (403) — never a public/predictable URL", async () => {
    const creditorUserId = "55555555-5555-5555-5555-555555555555";
    const debtorUserId = "66666666-6666-6666-6666-666666666666";
    const creditorProfileId = await seedPersonalParty(sigCtx, creditorUserId);
    const debtorProfileId = await seedPersonalParty(sigCtx, debtorUserId);
    const creditorSession = "77777777-7777-7777-7777-777777777777";
    const debtorSession = "88888888-8888-8888-8888-888888888888";
    await grantStepUp({ mfaCredentials: sigCtx.mfaCredentials, stepUps: sigCtx.stepUps }, creditorUserId, creditorSession);
    await grantStepUp({ mfaCredentials: sigCtx.mfaCredentials, stepUps: sigCtx.stepUps }, debtorUserId, debtorSession);
    await markFullyVerified(sigCtx, "personal", creditorProfileId);
    await markFullyVerified(sigCtx, "personal", debtorProfileId);

    const created = await sigCtx.agreementCtx.agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      category: "personal_loan",
      description: "test",
      originalAmountMinorUnits: 10_000,
      previousPaymentsMinorUnits: 0,
      firstPaymentMinorUnits: 5_000,
      installmentAmountMinorUnits: 5_000,
      frequency: "monthly",
      firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      feeAllocation: "split_evenly",
      earlyPayoffTerms: "none",
      hardshipRules: "none",
      partialPaymentRules: "none",
      settlementRules: "none",
      disputeProcedure: "none",
    });
    await sigCtx.agreementCtx.agreementService.submitDraft(created.agreement.id, creditorUserId);
    await sigCtx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
    await sigCtx.agreementCtx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
    await sigCtx.signatureService.sign({
      agreementId: created.agreement.id,
      actingUserId: creditorUserId,
      actingSessionId: creditorSession,
      authMethod: "totp",
      consentVersion: "v1",
      timezone: "UTC",
      deviceInfo: null,
      ipAddress: "203.0.113.10",
    });
    await sigCtx.signatureService.sign({
      agreementId: created.agreement.id,
      actingUserId: debtorUserId,
      actingSessionId: debtorSession,
      authMethod: "totp",
      consentVersion: "v1",
      timezone: "UTC",
      deviceInfo: null,
      ipAddress: "203.0.113.20",
    });

    const stranger = await authCtx.authService.signup({
      email: "stranger@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(getWithCookie(created.agreement.id, stranger.token));
    expect(response.status).toBe(403);
  });
});
