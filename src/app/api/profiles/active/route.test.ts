import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { ACTIVE_PROFILE_COOKIE_NAME } from "@/lib/profiles/activeProfileCookie";
import { createTestProfileAccessService } from "@/lib/profiles/testFakes";
import { createActiveProfileGetHandler, createActiveProfileSetHandler } from "./route";

function readSetCookie(response: Response, name: string): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = headers.getSetCookie ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const raw of rawCookies) {
    const [pair] = raw.split(";");
    const separatorIndex = pair?.indexOf("=") ?? -1;
    if (!pair || separatorIndex === -1) continue;
    if (pair.slice(0, separatorIndex) === name) return pair.slice(separatorIndex + 1);
  }
  return undefined;
}

function getWithCookies(sessionToken: string, activeProfileCookie?: string) {
  const cookie = [`p2p_session=${sessionToken}`, activeProfileCookie ? `${ACTIVE_PROFILE_COOKIE_NAME}=${activeProfileCookie}` : null]
    .filter(Boolean)
    .join("; ");
  return new NextRequest("http://localhost/api/profiles/active", { method: "GET", headers: { cookie } });
}

function postWithCookie(sessionToken: string, body: unknown) {
  return new NextRequest("http://localhost/api/profiles/active", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${sessionToken}` },
  });
}

describe("GET/POST /api/profiles/active", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let accessCtx: ReturnType<typeof createTestProfileAccessService>;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    accessCtx = createTestProfileAccessService();
    const result = await authCtx.authService.signup({
      email: "switcher@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
    await accessCtx.personalProfiles.insert(userId);
  });

  function getHandler() {
    return withErrorHandling(
      "profiles_active_get",
      createActiveProfileGetHandler(authCtx.authService, accessCtx.profileAccessService),
    );
  }

  function setHandler() {
    return withErrorHandling(
      "profiles_active_set",
      createActiveProfileSetHandler(authCtx.authService, accessCtx.profileAccessService),
    );
  }

  it("defaults to the personal profile with no active-profile cookie", async () => {
    const response = await getHandler()(getWithCookies(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("personal");
  });

  it("sets and re-resolves an owned business profile", async () => {
    const business = await accessCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });

    const setResponse = await setHandler()(postWithCookie(token, { kind: "business", businessProfileId: business.id }));
    expect(setResponse.status).toBe(200);
    const cookieValue = readSetCookie(setResponse, ACTIVE_PROFILE_COOKIE_NAME);
    expect(cookieValue).toBeTruthy();

    const getResponse = await getHandler()(getWithCookies(token, cookieValue as string));
    const body = (await getResponse.json()) as { kind: string; businessProfileId: string };
    expect(body.kind).toBe("business");
    expect(body.businessProfileId).toBe(business.id);
  });

  it("rejects setting another user's business profile as active with 403", async () => {
    const otherUsersBusiness = await accessCtx.businessProfiles.insert({
      ownerUserId: "someone-else",
      legalBusinessName: "Not Yours LLC",
      displayName: "Not Yours",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const response = await setHandler()(
      postWithCookie(token, { kind: "business", businessProfileId: otherUsersBusiness.id }),
    );
    expect(response.status).toBe(403);
  });

  it("falls back to personal when the cookie references a since-disabled business", async () => {
    const business = await accessCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Acme LLC",
      displayName: "Acme",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });
    const setResponse = await setHandler()(postWithCookie(token, { kind: "business", businessProfileId: business.id }));
    const cookieValue = readSetCookie(setResponse, ACTIVE_PROFILE_COOKIE_NAME) as string;

    accessCtx.businessProfiles.setStatus(business.id, "disabled");

    const getResponse = await getHandler()(getWithCookies(token, encodeURIComponent(cookieValue)));
    expect(getResponse.status).toBe(200);
    const body = (await getResponse.json()) as { kind: string };
    expect(body.kind).toBe("personal");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await setHandler()(
      new NextRequest("http://localhost/api/profiles/active", {
        method: "POST",
        body: JSON.stringify({ kind: "personal" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
