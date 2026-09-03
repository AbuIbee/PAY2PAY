import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestProfileAccessService } from "@/lib/profiles/testFakes";
import { createTestPricingService } from "@/lib/pricing/testFakes";
import { createPricingGetHandler } from "./route";

const URL = "http://localhost/api/profiles/pricing";

describe("GET /api/profiles/pricing", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let accessCtx: ReturnType<typeof createTestProfileAccessService>;
  let pricingCtx: ReturnType<typeof createTestPricingService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    accessCtx = createTestProfileAccessService();
    pricingCtx = createTestPricingService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "pricing-route@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    await accessCtx.personalProfiles.insert(result.user.id);
  });

  function handler() {
    return withErrorHandling(
      "profiles_pricing_get",
      createPricingGetHandler(authCtx.authService, accessCtx.profileAccessService, pricingCtx.pricingService),
    );
  }

  it("returns a null plan when no subscription exists", async () => {
    const response = await handler()(new NextRequest(URL, { headers: { cookie: `p2p_session=${token}` } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { plan: unknown; usage: { agreementsUsed: number } };
    expect(body.plan).toBeNull();
    expect(body.usage.agreementsUsed).toBe(0);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(new NextRequest(URL));
    expect(response.status).toBe(401);
  });
});
