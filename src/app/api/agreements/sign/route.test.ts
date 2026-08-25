import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestSignatureService, grantStepUp, markFullyVerified, seedPersonalParty } from "@/lib/signatures/testFakes";
import { createAgreementSignHandler } from "./route";

/**
 * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md) —
 * route-level negative-security coverage for the actual production signing endpoint, previously
 * only tested at the SignatureService layer (real, but not proof the HTTP boundary itself enforces
 * anything — every other sensitive route in this codebase has its own route.test.ts). Mirrors
 * businesses/route.test.ts's exact pattern: authCtx (issues/validates the session) and sigCtx
 * (SignatureService's own AgreementService instance) are deliberately separate contexts for the
 * pure-authentication-boundary tests (401 with no session, 403-equivalent for a stranger) — neither
 * needs the acting user to exist in the other's repos, since requireSession only needs a valid
 * session and SignatureService's own authorization re-derives everything from the agreement itself.
 */
describe("POST /api/agreements/sign", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let sigCtx: ReturnType<typeof createTestSignatureService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    sigCtx = createTestSignatureService();
  });

  function handler() {
    return withErrorHandling("agreement_sign", createAgreementSignHandler(authCtx.authService, sigCtx.signatureService));
  }

  function postJson(body: unknown, sessionToken?: string) {
    return new NextRequest("http://localhost/api/agreements/sign", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {}),
      },
    });
  }

  const validBody = { agreementId: "00000000-0000-0000-0000-000000000000", authMethod: "totp", consentVersion: "v1", timezone: "UTC" };

  it("PRSprint 12 requirement #21: rejects an anonymous (no-session) signing request — anonymous signing is prohibited", async () => {
    const response = await handler()(postJson(validBody));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed/garbage session token the same way (401)", async () => {
    const response = await handler()(postJson(validBody, "not-a-real-token"));
    expect(response.status).toBe(401);
  });

  it("rejects a request missing required fields before ever reaching SignatureService (400)", async () => {
    const signup = await authCtx.authService.signup({
      email: "signer@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(postJson({ agreementId: "not-a-uuid" }, signup.token));
    expect(response.status).toBe(400);
  });

  it("a real, authenticated user who is not a party to the agreement cannot sign it — server-side authorization, not just UI restriction (403)", async () => {
    const signup = await authCtx.authService.signup({
      email: "stranger@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    // A real agreement exists in sigCtx, but this signer has no relationship to it at all.
    const creditorUserId = "11111111-1111-1111-1111-111111111111";
    const debtorUserId = "22222222-2222-2222-2222-222222222222";
    const creditorProfileId = await seedPersonalParty(sigCtx, creditorUserId);
    const debtorProfileId = await seedPersonalParty(sigCtx, debtorUserId);
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

    const response = await handler()(
      postJson({ agreementId: created.agreement.id, authMethod: "totp", consentVersion: "v1", timezone: "UTC" }, signup.token),
    );
    expect(response.status).toBe(403);
  });

  it("a real party can sign through the actual HTTP route end to end (200), proving the route is wired correctly, not just the service", async () => {
    // The creditor is a *real* authCtx signup — its session is what requireSession trusts and what
    // SignatureService's own actingUserId comes from — seeded into sigCtx under that same id, so
    // personalProfiles.findByUserId(actingUserId) resolves correctly (unlike the "unauthorized
    // signer" test above, which deliberately does *not* do this, to prove a stranger is rejected).
    const signup = await authCtx.authService.signup({
      email: "creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtorUserId = "44444444-4444-4444-4444-444444444444";
    const creditorProfileId = await seedPersonalParty(sigCtx, signup.user.id);
    const debtorProfileId = await seedPersonalParty(sigCtx, debtorUserId);
    const created = await sigCtx.agreementCtx.agreementService.createDraft({
      creatorUserId: signup.user.id,
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
    await sigCtx.agreementCtx.agreementService.submitDraft(created.agreement.id, signup.user.id);
    await sigCtx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
    await sigCtx.agreementCtx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: signup.user.id, decision: "accept" });

    const sessionId = (await authCtx.authService.validateSession(signup.token))!.sessionId;
    await grantStepUp({ mfaCredentials: sigCtx.mfaCredentials, stepUps: sigCtx.stepUps }, signup.user.id, sessionId);
    await markFullyVerified(sigCtx, "personal", creditorProfileId);

    const response = await handler()(
      postJson({ agreementId: created.agreement.id, authMethod: "totp", consentVersion: "v1", timezone: "UTC" }, signup.token),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; signatureEventId: string; pdfGenerated: boolean };
    expect(body.status).toBe("awaiting_signatures"); // only one of two parties has signed
    expect(body.signatureEventId).toBeTruthy();
    expect(body.pdfGenerated).toBe(false);
  });
});
