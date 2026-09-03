import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestProfileAccessService } from "@/lib/profiles/testFakes";
import { createProfilesListHandler } from "./route";

function getWithCookie(token?: string) {
  return new NextRequest("http://localhost/api/profiles", {
    method: "GET",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("GET /api/profiles", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let accessCtx: ReturnType<typeof createTestProfileAccessService>;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    accessCtx = createTestProfileAccessService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "list@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
    await accessCtx.personalProfiles.insert(userId);
  });

  function handlerFor() {
    return withErrorHandling(
      "profiles_list",
      createProfilesListHandler(authCtx.authService, accessCtx.profileAccessService),
    );
  }

  it("lists the personal profile plus every active owned business", async () => {
    await accessCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });

    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { profiles: { kind: string }[] };
    expect(body.profiles.map((p) => p.kind).sort()).toEqual(["business", "personal"]);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie());
    expect(response.status).toBe(401);
  });
});
