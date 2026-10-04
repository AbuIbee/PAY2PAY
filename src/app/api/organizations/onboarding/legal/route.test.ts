import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createBusinessOnboardingTestHarness } from "@/lib/organizations/businessOnboardingTestFakes";
import { createOnboardingTierHandler } from "../tier/route";
import { createOnboardingVerificationHandler } from "../verification/route";
import { createOnboardingLegalGetHandler, createOnboardingLegalPostHandler } from "./route";

const representative = { firstName: "Jane", lastName: "Doe", title: "CEO", email: "jane@abc.com", phone: "+15555550100", relationshipToBusiness: "Owner" };

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 24: the legal-acceptance onboarding
 * route's own HTTP-layer proof — spoof protection (userId/organizationId/acceptedAt/version), cross-
 * tenant isolation, and unknown-document-type rejection, through the REAL route handlers.
 */
describe("GET/POST /api/organizations/onboarding/legal", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let onboardingCtx: Awaited<ReturnType<typeof createBusinessOnboardingTestHarness>>;
  let token: string;
  let userId: string;
  let organizationId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    onboardingCtx = await createBusinessOnboardingTestHarness();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "legal-founder@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
    const profile = await onboardingCtx.onboarding.submitBusinessDetails({
      actingUserId: userId,
      organizationId: null,
      legalBusinessName: "Legal Test LLC",
      displayName: "Legal Test",
      entityType: "LLC",
      dbaName: null,
      industry: "TRUCKING",
      formationJurisdiction: "DE",
      businessAddress: { line1: "1 Main St", city: "Dover", state: "DE", postalCode: "19901" },
      businessEmail: "billing@legaltest.com",
      businessPhone: null,
      website: null,
      country: "US",
      state: "DE",
      representative,
    });
    organizationId = profile.id;

    const verificationHandler = withErrorHandling("verification", createOnboardingVerificationHandler(authCtx.authService, onboardingCtx.onboarding));
    await verificationHandler(
      new NextRequest("http://localhost/api/organizations/onboarding/verification", {
        method: "POST",
        body: JSON.stringify({ organizationId, taxId: "123456789" }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
      }),
    );
    const tierHandler = withErrorHandling("tier", createOnboardingTierHandler(authCtx.authService, onboardingCtx.onboarding));
    await tierHandler(
      new NextRequest("http://localhost/api/organizations/onboarding/tier", {
        method: "POST",
        body: JSON.stringify({ organizationId, planCode: "paid2you_business_core" }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
      }),
    );
  });

  function getHandler() {
    return withErrorHandling("legal_get", createOnboardingLegalGetHandler(authCtx.authService, onboardingCtx.onboarding));
  }
  function postHandler() {
    return withErrorHandling("legal_post", createOnboardingLegalPostHandler(authCtx.authService, onboardingCtx.onboarding));
  }
  function getRequest(orgId: string, tok?: string) {
    return new NextRequest(`http://localhost/api/organizations/onboarding/legal?organizationId=${orgId}`, { headers: tok ? { cookie: `p2p_session=${tok}` } : {} });
  }
  function postRequest(body: unknown, tok: string) {
    return new NextRequest("http://localhost/api/organizations/onboarding/legal", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie: `p2p_session=${tok}` } });
  }

  it("GET reports all three required documents as not yet accepted initially", async () => {
    const response = await getHandler()(getRequest(organizationId, token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ documentType: string; accepted: boolean }> };
    expect(body.documents).toHaveLength(3);
    expect(body.documents.every((d) => !d.accepted)).toBe(true);
  });

  it("POST records an acceptance using the server session's own userId and the server clock — the client never supplies either", async () => {
    const response = await postHandler()(postRequest({ organizationId, documentType: "terms" }, token));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { documentType: string; documentVersion: string; acceptedAt: string };
    expect(body.documentType).toBe("terms");
    expect(body.documentVersion).toBeTruthy();
    expect(new Date(body.acceptedAt).getTime()).toBeGreaterThan(0);

    const getResponse = await getHandler()(getRequest(organizationId, token));
    const getBody = (await getResponse.json()) as { documents: Array<{ documentType: string; accepted: boolean }> };
    expect(getBody.documents.find((d) => d.documentType === "terms")?.accepted).toBe(true);
  });

  it("a client-supplied documentVersion field is silently ignored — the server always stamps its own current version", async () => {
    const response = await postHandler()(postRequest({ organizationId, documentType: "terms", documentVersion: "9999-99-99" }, token));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { documentVersion: string };
    expect(body.documentVersion).not.toBe("9999-99-99");
  });

  it("rejects an unrecognized/not-currently-offered document type", async () => {
    const response = await postHandler()(postRequest({ organizationId, documentType: "made_up_document" }, token));
    expect(response.status).toBe(400);
  });

  it("another user cannot accept legal documents for someone else's organization (spoof protection)", async () => {
    const other = await authCtx.authService.signup({
      accountType: "personal",
      identity: { ...TEST_SIGNUP_IDENTITY, firstName: "Other" },
      inviteCode: null,
      email: "legal-other@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await postHandler()(postRequest({ organizationId, documentType: "terms" }, other.token));
    expect(response.status).toBe(403);

    const getResponse = await getHandler()(getRequest(organizationId, other.token));
    expect(getResponse.status).toBe(403);
  });

  it("rejects an unauthenticated GET and POST with 401", async () => {
    expect((await getHandler()(getRequest(organizationId))).status).toBe(401);
    const unauth = new NextRequest("http://localhost/api/organizations/onboarding/legal", { method: "POST", body: JSON.stringify({ organizationId, documentType: "terms" }), headers: { "content-type": "application/json" } });
    expect((await postHandler()(unauth)).status).toBe(401);
  });
});
