import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
import { ACTIVE_PROFILE_COOKIE_NAME } from "@/lib/profiles/activeProfileCookie";
import { createTestProfileAccessService } from "@/lib/profiles/testFakes";
import { resetRateLimits } from "@/lib/rate-limit";
import { createActiveProfileGetHandler, createActiveProfileSetHandler } from "../profiles/active/route";
import { createLoginHandler } from "./login/route";
import { createLogoutHandler } from "./logout/route";
import { createMeHandler } from "./me/route";

/**
 * PRSprint 11A (docs/prsprints/PRSPRINT_11A_LOGIN_AUTHENTICATION_REGRESSION_REMEDIATION.md):
 * permanent end-to-end regression coverage for the full login/logout lifecycle through the actual
 * route handlers (not just the AuthService layer, which already had its own coverage and did not
 * catch this incident — the incident was in a cross-cutting dependency, checkRateLimit, that every
 * route calls, so the regression test has to exercise the real HTTP handlers to be meaningful).
 *
 * The specific scenario that must never regress again: login -> logout -> login again -> the second
 * login succeeds. Every scenario below shares one AuthService/ProfileAccessService instance pair
 * across a single email, mirroring how one browser session actually behaves.
 */
describe("login/logout lifecycle (route-handler level)", () => {
  const EMAIL = "cycle-user@example.com";
  const PASSWORD = "a-strong-password";

  let authCtx: ReturnType<typeof createTestAuthService>;
  let accessCtx: ReturnType<typeof createTestProfileAccessService>;
  let userId: string;

  beforeEach(async () => {
    resetRateLimits();
    authCtx = createTestAuthService();
    accessCtx = createTestProfileAccessService();
    const signedUp = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: EMAIL,
      password: PASSWORD,
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    userId = signedUp.user.id;
    await accessCtx.personalProfiles.insert(userId);
  });

  function loginHandler() {
    return withErrorHandling("auth_login", createLoginHandler(authCtx.authService));
  }
  function logoutHandler() {
    return withErrorHandling("auth_logout", createLogoutHandler(authCtx.authService));
  }
  function meHandler() {
    return withErrorHandling("auth_me", createMeHandler(authCtx.authService));
  }
  function activeProfileGetHandler() {
    return withErrorHandling(
      "profiles_active_get",
      createActiveProfileGetHandler(authCtx.authService, accessCtx.profileAccessService),
    );
  }
  function activeProfileSetHandler() {
    return withErrorHandling(
      "profiles_active_set",
      createActiveProfileSetHandler(authCtx.authService, accessCtx.profileAccessService),
    );
  }

  async function login(email: string = EMAIL, password: string = PASSWORD): Promise<{ status: number; token?: string }> {
    const response = await loginHandler()(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json" },
      }),
    );
    return { status: response.status, token: readSetCookie(response, "p2p_session") };
  }

  async function logout(token: string): Promise<{ status: number }> {
    const response = await logoutHandler()(
      new NextRequest("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: `p2p_session=${token}` },
      }),
    );
    return { status: response.status };
  }

  function meWithCookie(token?: string) {
    return meHandler()(
      new NextRequest("http://localhost/api/auth/me", {
        headers: token ? { cookie: `p2p_session=${token}` } : {},
      }),
    );
  }

  it("valid login: correct credentials reach a protected route", async () => {
    const { status, token } = await login();
    expect(status).toBe(200);
    expect(token).toBeTruthy();
    const me = await meWithCookie(token);
    expect(me.status).toBe(200);
  });

  it("invalid login: an incorrect password is rejected", async () => {
    const { status, token } = await login(EMAIL, "wrong-password");
    expect(status).toBe(401);
    expect(token).toBeUndefined();
  });

  it("session persistence: a refresh (re-request with the same cookie) stays logged in", async () => {
    const { token } = await login();
    const firstMe = await meWithCookie(token);
    const secondMe = await meWithCookie(token); // simulates a page refresh
    expect(firstMe.status).toBe(200);
    expect(secondMe.status).toBe(200);
  });

  it("logout: after logging out, the protected route is denied", async () => {
    const { token } = await login();
    const loggedOut = await logout(token!);
    expect(loggedOut.status).toBe(200);
    const me = await meWithCookie(token);
    expect(me.status).toBe(401);
  });

  it("MANDATORY: login -> logout -> login again -> the second login succeeds and its session works", async () => {
    const first = await login();
    expect(first.status).toBe(200);

    await logout(first.token!);

    const second = await login();
    expect(second.status).toBe(200);
    expect(second.token).toBeTruthy();
    expect(second.token).not.toBe(first.token);

    // The new session must work...
    const me = await meWithCookie(second.token);
    expect(me.status).toBe(200);
    // ...and the old, revoked session must still be denied (logout must not have been undone).
    const staleMe = await meWithCookie(first.token);
    expect(staleMe.status).toBe(401);
  });

  it("multiple login/logout cycles: three full cycles each leave the session in the correct state", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const { status, token } = await login();
      expect(status).toBe(200);
      expect((await meWithCookie(token)).status).toBe(200);

      const loggedOut = await logout(token!);
      expect(loggedOut.status).toBe(200);
      expect((await meWithCookie(token)).status).toBe(401);
    }
  });

  it("browser Back: revisiting a protected route with the pre-logout cookie is still denied", async () => {
    const { token } = await login();
    await logout(token!);
    const back = await meWithCookie(token); // Back resends whatever cookie the browser still has
    expect(back.status).toBe(401);
  });

  it("direct protected URL: denied while logged out, allowed again after logging back in", async () => {
    const loggedOutMe = await meWithCookie(undefined);
    expect(loggedOutMe.status).toBe(401);

    const { token } = await login();
    const loggedInMe = await meWithCookie(token);
    expect(loggedInMe.status).toBe(200);
  });

  it("business context: login, set an owned business as active, logout clears it, login again re-establishes it", async () => {
    const business = await accessCtx.businessProfiles.insert({
      ownerUserId: userId,
      legalBusinessName: "Cycle Business LLC",
      displayName: "Cycle Business",
      entityType: "llc",
      businessAddress: null,
      country: "US",
      state: "CA",
    });

    const { token: firstToken } = await login();

    const setResponse = await activeProfileSetHandler()(
      new NextRequest("http://localhost/api/profiles/active", {
        method: "POST",
        body: JSON.stringify({ kind: "business", businessProfileId: business.id }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${firstToken}` },
      }),
    );
    expect(setResponse.status).toBe(200);
    const activeProfileCookie = readSetCookie(setResponse, ACTIVE_PROFILE_COOKIE_NAME);
    expect(activeProfileCookie).toBeTruthy();

    const contextLoaded = await activeProfileGetHandler()(
      new NextRequest("http://localhost/api/profiles/active", {
        headers: { cookie: `p2p_session=${firstToken}; ${ACTIVE_PROFILE_COOKIE_NAME}=${activeProfileCookie}` },
      }),
    );
    const contextBody = (await contextLoaded.json()) as { kind: string; businessProfileId: string };
    expect(contextBody.kind).toBe("business");
    expect(contextBody.businessProfileId).toBe(business.id);

    const logoutResponse = await logoutHandler()(
      new NextRequest("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: `p2p_session=${firstToken}` },
      }),
    );
    expect(readSetCookie(logoutResponse, ACTIVE_PROFILE_COOKIE_NAME)).toBe("");

    const { token: secondToken } = await login();
    expect(secondToken).toBeTruthy();

    // No active-profile cookie was sent this time (as a fresh browser session after logout
    // wouldn't have one) — it must default back to personal, not silently reuse the old business.
    const freshContext = await activeProfileGetHandler()(
      new NextRequest("http://localhost/api/profiles/active", {
        headers: { cookie: `p2p_session=${secondToken}` },
      }),
    );
    expect((await freshContext.json() as { kind: string }).kind).toBe("personal");

    // The business context can still be re-established after the fresh login.
    const resetResponse = await activeProfileSetHandler()(
      new NextRequest("http://localhost/api/profiles/active", {
        method: "POST",
        body: JSON.stringify({ kind: "business", businessProfileId: business.id }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${secondToken}` },
      }),
    );
    expect(resetResponse.status).toBe(200);
  });

  it.each([
    ["Platform Admin", "platform_admin"] as const,
    ["Platform Owner", "platform_owner"] as const,
  ])("%s: login works, logout works, and a subsequent login works", async (_label, platformRole) => {
    authCtx.users.setPlatformRole(userId, platformRole);

    const first = await login();
    expect(first.status).toBe(200);
    expect((await meWithCookie(first.token)).status).toBe(200);

    const loggedOut = await logout(first.token!);
    expect(loggedOut.status).toBe(200);
    expect((await meWithCookie(first.token)).status).toBe(401);

    const second = await login();
    expect(second.status).toBe(200);
    expect((await meWithCookie(second.token)).status).toBe(200);
  });
});
