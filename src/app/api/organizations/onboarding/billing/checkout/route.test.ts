import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES } from "@/lib/legal/legalDocumentVersions";
import { createBusinessOnboardingTestHarness } from "@/lib/organizations/businessOnboardingTestFakes";
import { createOnboardingLegalPostHandler } from "../../legal/route";
import { createOnboardingTierHandler } from "../../tier/route";
import { createOnboardingVerificationHandler } from "../../verification/route";
import { createOnboardingBillingCheckoutHandler } from "./route";

const representative = { firstName: "Jane", lastName: "Doe", title: "CEO", email: "jane@abc.com", phone: "+15555550100", relationshipToBusiness: "Owner" };

/**
 * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 8-E: the hosted-checkout
 * onboarding route's own HTTP-layer proof — authorized Business user can begin hosted setup, wrong
 * org/nonmember denied, the required legal gate is enforced, Enterprise is rejected from standard
 * self-service, and — critically — creating the session never itself activates anything (Section 10's
 * own "a redirect is UX only").
 */
describe("POST /api/organizations/onboarding/billing/checkout", () => {
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
      email: "checkout-founder@example.com",
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
      legalBusinessName: "Checkout Test LLC",
      displayName: "Checkout Test",
      entityType: "LLC",
      dbaName: null,
      industry: "TRUCKING",
      formationJurisdiction: "DE",
      businessAddress: { line1: "1 Main St", city: "Dover", state: "DE", postalCode: "19901" },
      businessEmail: "billing@checkouttest.com",
      businessPhone: null,
      website: null,
      country: "US",
      state: "DE",
      representative,
    });
    organizationId = profile.id;
  });

  function handler() {
    return withErrorHandling("billing_checkout", createOnboardingBillingCheckoutHandler(authCtx.authService, onboardingCtx.onboarding));
  }
  function postRequest(body: unknown, tok?: string) {
    return new NextRequest("http://localhost/api/organizations/onboarding/billing/checkout", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(tok ? { cookie: `p2p_session=${tok}` } : {}) },
    });
  }

  async function submitVerificationAndTier(planCode = "paid2you_business_core") {
    const verificationHandler = withErrorHandling("verification", createOnboardingVerificationHandler(authCtx.authService, onboardingCtx.onboarding));
    await verificationHandler(postRequest({ organizationId, taxId: "123456789" }, token));
    const tierHandler = withErrorHandling("tier", createOnboardingTierHandler(authCtx.authService, onboardingCtx.onboarding));
    await tierHandler(postRequest({ organizationId, planCode }, token));
  }

  async function acceptAllRequiredLegalDocuments() {
    const legalHandler = withErrorHandling("legal", createOnboardingLegalPostHandler(authCtx.authService, onboardingCtx.onboarding));
    for (const documentType of REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES) {
      await legalHandler(postRequest({ organizationId, documentType }, token));
    }
  }

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(postRequest({ organizationId, billingEmail: "b@b.com" }));
    expect(response.status).toBe(401);
  });

  it("rejects before a tier is selected", async () => {
    const response = await handler()(postRequest({ organizationId, billingEmail: "b@b.com" }, token));
    expect(response.status).toBe(400);
  });

  it("enforces the required legal-acceptance gate before hosted checkout can begin", async () => {
    await submitVerificationAndTier();
    const response = await handler()(postRequest({ organizationId, billingEmail: "b@b.com" }, token));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/legal/i);
  });

  it("authorized Business owner can begin hosted checkout once verification/tier/legal are all satisfied — never activates anything itself", async () => {
    await submitVerificationAndTier();
    await acceptAllRequiredLegalDocuments();

    const response = await handler()(postRequest({ organizationId, billingEmail: "b@b.com" }, token));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { hostedUrl: string };
    expect(body.hostedUrl).toBeTruthy();

    const state = await onboardingCtx.onboarding.getOnboardingState({ actingUserId: userId, organizationId });
    expect(state.activation.active).toBe(false);
    expect(state.subscription?.providerSubscriptionReference ?? null).toBeNull();
  });

  it("denies a nonmember/wrong-org caller", async () => {
    await submitVerificationAndTier();
    await acceptAllRequiredLegalDocuments();
    const other = await authCtx.authService.signup({
      accountType: "personal",
      identity: { ...TEST_SIGNUP_IDENTITY, firstName: "Other" },
      inviteCode: null,
      email: "other-checkout@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(postRequest({ organizationId, billingEmail: "b@b.com" }, other.token));
    expect(response.status).toBe(403);
  });

  it("rejects Enterprise from self-service hosted checkout", async () => {
    await submitVerificationAndTier("paid2you_business_enterprise");
    await acceptAllRequiredLegalDocuments();
    const response = await handler()(postRequest({ organizationId, billingEmail: "b@b.com" }, token));
    expect(response.status).toBe(400);
  });
});
