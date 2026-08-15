import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestEvidenceWitnessContext } from "@/lib/evidence/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createEvidenceSignedUrlHandler } from "./route";

/**
 * PRSprint 02 (docs/prsprints/PRSPRINT_02_RLS_CROSS_TENANT_SECURITY.md): route-level cross-tenant/
 * IDOR coverage for GET /api/agreements/evidence/signed-url — a document-access endpoint, one of the
 * scope's explicitly named IDOR targets ("...document IDs"). EvidenceService.getSignedEvidenceUrl
 * already has unit-level stranger-rejection coverage (src/lib/evidence/evidenceService.test.ts), but
 * nothing previously exercised the route boundary that actually issues the signed URL to a client.
 */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

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
    hardshipRules: "Borrower may request hardship relief.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

function getWithCookie(evidenceId: string | null, token?: string) {
  const url = evidenceId
    ? `http://localhost/api/agreements/evidence/signed-url?id=${evidenceId}`
    : "http://localhost/api/agreements/evidence/signed-url";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/agreements/evidence/signed-url", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let evidenceCtx: ReturnType<typeof createTestEvidenceWitnessContext>;
  let evidenceId: string;
  let creditorToken: string;
  let strangerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    evidenceCtx = createTestEvidenceWitnessContext();

    const creditor = await authCtx.authService.signup({
      email: "evidence-creditor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      email: "evidence-debtor@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      email: "evidence-stranger@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    creditorToken = creditor.token;
    strangerToken = stranger.token;

    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    evidenceCtx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditor.user.id);
    evidenceCtx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtor.user.id);

    const created = await evidenceCtx.agreementCtx.agreementService.createDraft({
      creatorUserId: creditor.user.id,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });

    const record = await evidenceCtx.evidenceService.uploadEvidence({
      agreementId: created.agreement.id,
      actingUserId: creditor.user.id,
      documentType: "invoice",
      description: "Original invoice",
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      content: PDF_BYTES,
      visibility: "shared",
      sharedWithWitnesses: false,
      ipAddress: "203.0.113.1",
      deviceInfo: null,
    });
    evidenceId = record.id;
  });

  function handlerFor() {
    return withErrorHandling(
      "evidence_signed_url",
      createEvidenceSignedUrlHandler(authCtx.authService, evidenceCtx.evidenceService),
    );
  }

  it("issues a signed URL to an agreement party", async () => {
    const response = await handlerFor()(getWithCookie(evidenceId, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.signedUrl).toBe("string");
  });

  it("rejects a cross-tenant IDOR attempt: an authenticated stranger cannot obtain a signed URL for someone else's document by id", async () => {
    const response = await handlerFor()(getWithCookie(evidenceId, strangerToken));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie(evidenceId));
    expect(response.status).toBe(401);
  });
});
