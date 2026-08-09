import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestProfileAccessService } from "@/lib/profiles/testFakes";
import { createBusinessDashboardHandler } from "./route";

function getWithCookie(businessProfileId: string | null, token?: string) {
  const url = businessProfileId
    ? `http://localhost/api/dashboard/business?businessProfileId=${businessProfileId}`
    : "http://localhost/api/dashboard/business";
  return new NextRequest(url, { method: "GET", headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/dashboard/business", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let accessCtx: ReturnType<typeof createTestProfileAccessService>;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    accessCtx = createTestProfileAccessService();
    const result = await authCtx.authService.signup({
      email: "dash-business@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
  });

  function handlerFor() {
    return withErrorHandling(
      "dashboard_business",
      createBusinessDashboardHandler(authCtx.authService, accessCtx.profileAccessService),
    );
  }

  it("returns real empty-state data for an owned business", async () => {
    const business = await accessCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const response = await handlerFor()(getWithCookie(business.id, token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      receivablesMinorUnits: 0,
      payablesMinorUnits: 0,
      agreements: [],
      customers: [],
      staffPlaceholder: true,
      reportsPlaceholder: true,
    });
  });

  it("rejects a business the caller does not own with 403", async () => {
    const otherBusiness = await accessCtx.businessProfiles.insert({
      ownerUserId: "someone-else",
      legalBusinessName: "Not Yours LLC",
      displayName: "Not Yours",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const response = await handlerFor()(getWithCookie(otherBusiness.id, token));
    expect(response.status).toBe(403);
  });

  it("rejects a missing businessProfileId with 400", async () => {
    const response = await handlerFor()(getWithCookie(null, token));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie("00000000-0000-0000-0000-000000000000"));
    expect(response.status).toBe(401);
  });
});
