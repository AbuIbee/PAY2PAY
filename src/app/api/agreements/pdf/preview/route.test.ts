import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestSignatureService, markFullyVerified, seedPersonalParty } from "@/lib/signatures/testFakes";
import { createAgreementPdfPreviewHandler } from "./route";

/**
 * Agreement Lifecycle V2 (Part 6 — Print/PDF): route-level coverage for the live-preview PDF
 * endpoint, which (unlike GET /api/agreements/pdf) must be reachable while an agreement is still a
 * Draft/Review-state — no signed, stored document exists yet. Same authorization requirement as the
 * executed-PDF route: no session (401), and a stranger to the agreement (403).
 */
describe("GET /api/agreements/pdf/preview", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let sigCtx: ReturnType<typeof createTestSignatureService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    sigCtx = createTestSignatureService();
  });

  function handler() {
    return withErrorHandling("agreement_pdf_preview", createAgreementPdfPreviewHandler(authCtx.authService, sigCtx.signatureService));
  }

  function getWithCookie(id: string, sessionToken?: string) {
    return new NextRequest(`http://localhost/api/agreements/pdf/preview?id=${id}`, {
      headers: sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {},
    });
  }

  it("rejects a request with no session (401)", async () => {
    const response = await handler()(getWithCookie("00000000-0000-0000-0000-000000000000"));
    expect(response.status).toBe(401);
  });

  it("a real, authenticated stranger to the agreement cannot preview its PDF (403) — never a public/predictable URL", async () => {
    const creditorUserId = "55555555-5555-5555-5555-555555555555";
    const debtorUserId = "66666666-6666-6666-6666-666666666666";
    const creditorProfileId = await seedPersonalParty(sigCtx, creditorUserId);
    const debtorProfileId = await seedPersonalParty(sigCtx, debtorUserId);
    await markFullyVerified(sigCtx, "personal", creditorProfileId);
    await markFullyVerified(sigCtx, "personal", debtorProfileId);

    const created = await sigCtx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
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

    const stranger = await authCtx.authService.signup({
      email: "stranger-preview@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(getWithCookie(created.agreement.id, stranger.token));
    expect(response.status).toBe(403);
  });

  it("a party to a still-draft agreement receives an inline PDF (200) — the point of a live preview", async () => {
    const creditor = await authCtx.authService.signup({
      email: "creditor-preview-party@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "debtor-preview-party@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const creditorUserId = creditor.user.id;
    const debtorUserId = debtor.user.id;
    const creditorProfileId = await seedPersonalParty(sigCtx, creditorUserId);
    const debtorProfileId = await seedPersonalParty(sigCtx, debtorUserId);
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

    const response = await handler()(getWithCookie(created.agreement.id, creditor.token));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });
});
