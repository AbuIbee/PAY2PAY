import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestBusinessProfileService } from "@/lib/profiles/testFakes";
import { createBusinessProfileCreateHandler, createBusinessProfileListHandler } from "./route";

const URL = "http://localhost/api/profiles/business";

function postWithCookie(body: unknown, token?: string) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `p2p_session=${token}` } : {}),
    },
  });
}

function getWithCookie(token?: string) {
  return new NextRequest(URL, {
    method: "GET",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

const validBody = {
  legalBusinessName: "Acme Repair LLC",
  displayName: "Acme Repair",
  entityType: "llc",
  businessAddress: { line1: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701" },
  country: "US",
  state: "IL",
};

describe("POST/GET /api/profiles/business", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let bizCtx: ReturnType<typeof createTestBusinessProfileService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    bizCtx = createTestBusinessProfileService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "bizowner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function createHandler() {
    return withErrorHandling(
      "business_profile_create",
      createBusinessProfileCreateHandler(authCtx.authService, bizCtx.businessProfileService),
    );
  }

  function listHandler() {
    return withErrorHandling(
      "business_profile_list",
      createBusinessProfileListHandler(authCtx.authService, bizCtx.businessProfileService),
    );
  }

  it("creates a business profile for the authenticated user and returns 201", async () => {
    const response = await createHandler()(postWithCookie(validBody, token));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; legalBusinessName: string };
    expect(body.legalBusinessName).toBe("Acme Repair LLC");
  });

  it("rejects an unauthenticated create with 401", async () => {
    const response = await createHandler()(postWithCookie(validBody));
    expect(response.status).toBe(401);
  });

  it("rejects a missing required field with 400", async () => {
    const { displayName: _displayName, ...withoutDisplayName } = validBody;
    void _displayName;
    const response = await createHandler()(postWithCookie(withoutDisplayName, token));
    expect(response.status).toBe(400);
  });

  it("lists only the caller's own business profiles", async () => {
    await createHandler()(postWithCookie(validBody, token));
    await createHandler()(postWithCookie({ ...validBody, legalBusinessName: "Second LLC" }, token));

    const response = await listHandler()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { businesses: { legalBusinessName: string }[] };
    expect(body.businesses).toHaveLength(2);
  });

  it("rejects an unauthenticated list with 401", async () => {
    const response = await listHandler()(getWithCookie());
    expect(response.status).toBe(401);
  });
});
