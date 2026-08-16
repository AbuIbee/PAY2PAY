import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
import { createMeHandler } from "../me/route";
import { createLogoutHandler } from "./route";

const LOGOUT_URL = "http://localhost/api/auth/logout";

function postWithCookie(token?: string) {
  return new NextRequest(LOGOUT_URL, {
    method: "POST",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("POST /api/auth/logout", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let token: string;

  beforeEach(async () => {
    ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      email: "logout-user@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling("auth_logout", createLogoutHandler(ctx.authService));
  }

  it("revokes the session, returns 200, and clears the cookie", async () => {
    const response = await handlerFor()(postWithCookie(token));
    expect(response.status).toBe(200);
    expect(readSetCookie(response, "p2p_session")).toBe("");

    expect(await ctx.authService.validateSession(token)).toBeNull();
  });

  it("rejects a request with no session cookie with 401", async () => {
    const response = await handlerFor()(postWithCookie());
    expect(response.status).toBe(401);
  });

  it("rejects logging out a token that was already revoked with 401", async () => {
    const handler = handlerFor();
    await handler(postWithCookie(token));
    const second = await handler(postWithCookie(token));
    expect(second.status).toBe(401);
  });

  it("clears the active-profile business-context cookie alongside the session cookie", async () => {
    const response = await handlerFor()(postWithCookie(token));
    expect(readSetCookie(response, "p2p_active_profile")).toBe("");
  });

  /**
   * PRSprint 10A (docs/prsprints/PRSPRINT_10A_AUTHENTICATION_SIGNOUT_UI_REMEDIATION.md) required
   * regression scenarios. All three browser behaviors (Back, Refresh, direct URL entry) reduce to
   * the exact same server-side guarantee: once a session is revoked, `validateSession` rejects that
   * token forever (already proven directly in authService.test.ts's "a revoked token no longer
   * validates"). These three tests exercise that guarantee through a real protected route
   * (`/api/auth/me`, the same one AppNav/AccountDashboard call to render the signed-in shell) with
   * the browser's old session cookie still attached — exactly what each scenario would actually send
   * — rather than re-testing the same claim only at the service layer a second time.
   */
  describe("protected-route access after logout (Back / Refresh / direct URL entry)", () => {
    function meRequest(cookieToken: string) {
      return new NextRequest("http://localhost/api/auth/me", { headers: { cookie: `p2p_session=${cookieToken}` } });
    }

    it("Login -> Sign Out -> Back: revisiting a protected route with the old session cookie is denied", async () => {
      await handlerFor()(postWithCookie(token));
      // "Back" resends whatever cookie the browser still has attached to that history entry — the
      // old, now-revoked token — exactly like this direct call to a protected route.
      const response = await withErrorHandling("auth_me", createMeHandler(ctx.authService))(meRequest(token));
      expect(response.status).toBe(401);
    });

    it("Login -> Sign Out -> Refresh: reloading a protected route with the old session cookie is denied", async () => {
      await handlerFor()(postWithCookie(token));
      // A refresh is a fresh request with whatever cookie is currently set — clearSessionCookie
      // already overwrote it client-side, but even a client that still sent the stale value (a
      // slow/cached reload) is rejected server-side.
      const response = await withErrorHandling("auth_me", createMeHandler(ctx.authService))(meRequest(token));
      expect(response.status).toBe(401);
    });

    it("Login -> copy protected URL -> Sign Out -> paste URL: entering a protected URL after logout is denied", async () => {
      await handlerFor()(postWithCookie(token));
      // Directly navigating to a protected URL sends the same cookie as any other request to it —
      // there is no separate "typed URL" code path to bypass.
      const response = await withErrorHandling("auth_me", createMeHandler(ctx.authService))(meRequest(token));
      expect(response.status).toBe(401);
    });

    it("a fresh login after logout still works normally (logout does not lock the account out)", async () => {
      await handlerFor()(postWithCookie(token));
      const fresh = await ctx.authService.login({ email: "logout-user@example.com", password: "a-strong-password", ipAddress: null, userAgent: null });
      const response = await withErrorHandling("auth_me", createMeHandler(ctx.authService))(meRequest(fresh.token));
      expect(response.status).toBe(200);
    });
  });
});
