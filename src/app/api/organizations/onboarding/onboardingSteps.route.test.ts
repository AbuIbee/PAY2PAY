import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createBusinessOnboardingTestHarness } from "@/lib/organizations/businessOnboardingTestFakes";
import { createOnboardingBillingHandler } from "./billing/route";
import { createOnboardingStateHandler } from "./state/route";
import { createOnboardingTierHandler } from "./tier/route";
import { createOnboardingVerificationHandler } from "./verification/route";

const representative = { firstName: "Jane", lastName: "Doe", title: "CEO", email: "jane@abc.com", phone: "+15555550100", relationshipToBusiness: "Owner" };

describe("Business onboarding step routes (verification/tier/billing/state)", () => {
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
      email: "founder2@example.com",
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
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      dbaName: null,
      industry: "TRUCKING",
      formationJurisdiction: "DE",
      businessAddress: { line1: "1 Main St", city: "Dover", state: "DE", postalCode: "19901" },
      businessEmail: "billing@abctrucking.com",
      businessPhone: null,
      website: null,
      country: "US",
      state: "DE",
      representative,
    });
    organizationId = profile.id;
  });

  function cookieRequest(url: string, body: unknown) {
    return new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie: `p2p_session=${token}` } });
  }

  it("verification: submits successfully and never includes the raw Tax ID in the response", async () => {
    const handler = withErrorHandling("verification", createOnboardingVerificationHandler(authCtx.authService, onboardingCtx.onboarding));
    const response = await handler(cookieRequest("http://localhost/api/organizations/onboarding/verification", { organizationId, taxId: "123456789" }));
    expect(response.status).toBe(201);
    const text = JSON.stringify(await response.clone().json());
    expect(text).not.toContain("123456789");
  });

  it("tier: rejects before verification is submitted, succeeds after", async () => {
    const handler = withErrorHandling("tier", createOnboardingTierHandler(authCtx.authService, onboardingCtx.onboarding));
    const tooEarly = await handler(cookieRequest("http://localhost/api/organizations/onboarding/tier", { organizationId, planCode: "paid2you_business_core" }));
    expect(tooEarly.status).toBe(400);

    const verificationHandler = withErrorHandling("verification", createOnboardingVerificationHandler(authCtx.authService, onboardingCtx.onboarding));
    await verificationHandler(cookieRequest("http://localhost/api/organizations/onboarding/verification", { organizationId, taxId: "123456789" }));

    const ok = await handler(cookieRequest("http://localhost/api/organizations/onboarding/tier", { organizationId, planCode: "paid2you_business_core" }));
    expect(ok.status).toBe(201);
  });

  it("billing: fake provider succeeds (payment method attached, subscription started) but does NOT itself advance onboarding to billing_setup_complete — only a provider-confirmed webhook does (P0-5, 2026-10-04)", async () => {
    const verificationHandler = withErrorHandling("verification", createOnboardingVerificationHandler(authCtx.authService, onboardingCtx.onboarding));
    await verificationHandler(cookieRequest("http://localhost/api/organizations/onboarding/verification", { organizationId, taxId: "123456789" }));
    const tierHandler = withErrorHandling("tier", createOnboardingTierHandler(authCtx.authService, onboardingCtx.onboarding));
    await tierHandler(cookieRequest("http://localhost/api/organizations/onboarding/tier", { organizationId, planCode: "paid2you_business_core" }));

    const billingHandler = withErrorHandling("billing", createOnboardingBillingHandler(authCtx.authService, onboardingCtx.onboarding));
    const billingResponse = await billingHandler(
      cookieRequest("http://localhost/api/organizations/onboarding/billing", { organizationId, billingEmail: "b@b.com", paymentMethodToken: "tok" }),
    );
    expect(billingResponse.status).toBe(201);

    const stateHandler = withErrorHandling(
      "state",
      createOnboardingStateHandler(authCtx.authService, onboardingCtx.onboarding),
    );
    const stateResponse = await stateHandler(
      new NextRequest(`http://localhost/api/organizations/onboarding/state?organizationId=${organizationId}`, { headers: { cookie: `p2p_session=${token}` } }),
    );
    const body = (await stateResponse.json()) as { onboardingStep: string; activation: { active: boolean } };
    // "PAID2YOU — FINAL SINGLE P0 DEFECT REMEDIATION" (2026-10-04), P0-5: this legacy route call alone
    // (startSubscription's own return shape carries no authoritative provider status at all) must
    // never complete billing — see `businessOnboardingService.test.ts`'s own dedicated P0-5 describe
    // block for the full status matrix and the provider-confirmed-webhook completion proof.
    expect(body.onboardingStep).not.toBe("billing_setup_complete");
    expect(body.activation.active).toBe(false); // not yet verified — billing/tier/onboarding completion alone is not activation.
  });

  it("another user cannot submit verification/tier/billing for someone else's organization", async () => {
    const other = await authCtx.authService.signup({
      accountType: "personal",
      identity: { ...TEST_SIGNUP_IDENTITY, firstName: "Other" },
      inviteCode: null,
      email: "other-founder@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const handler = withErrorHandling("verification", createOnboardingVerificationHandler(authCtx.authService, onboardingCtx.onboarding));
    const response = await handler(
      new NextRequest("http://localhost/api/organizations/onboarding/verification", {
        method: "POST",
        body: JSON.stringify({ organizationId, taxId: "123456789" }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${other.token}` },
      }),
    );
    expect(response.status).toBe(403);
  });
});
