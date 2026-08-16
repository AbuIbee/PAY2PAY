import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
import { createLogoutAllHandler } from "./route";

const LOGOUT_ALL_URL = "http://localhost/api/account/sessions/logout-all";

function postWithCookie(token?: string) {
  return new NextRequest(LOGOUT_ALL_URL, {
    method: "POST",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("POST /api/account/sessions/logout-all", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let firstToken: string;
  let secondToken: string;
  const email = "logout-all-user@example.com";
  const password = "a-strong-password";

  beforeEach(async () => {
    ctx = createTestAuthService();
    const signupResult = await ctx.authService.signup({
      email,
      password,
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    firstToken = signupResult.token;
    const loginResult = await ctx.authService.login({ email, password, ipAddress: null, userAgent: null });
    secondToken = loginResult.token;
  });

  function handlerFor() {
    return withErrorHandling("account_sessions_logout_all", createLogoutAllHandler(ctx.authService));
  }

  it("rejects access with no session cookie (401)", async () => {
    const response = await handlerFor()(postWithCookie());
    expect(response.status).toBe(401);
  });

  it("revokes every session for the caller, including ones from other devices, and clears the cookie", async () => {
    const response = await handlerFor()(postWithCookie(firstToken));
    expect(response.status).toBe(200);
    expect(readSetCookie(response, "p2p_session")).toBe("");

    expect(await ctx.authService.validateSession(firstToken)).toBeNull();
    expect(await ctx.authService.validateSession(secondToken)).toBeNull();
  });

  it("does not affect another user's sessions", async () => {
    const other = await ctx.authService.signup({
      email: "other-logout-all-user@example.com",
      password,
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });

    await handlerFor()(postWithCookie(firstToken));
    expect(await ctx.authService.validateSession(other.token)).not.toBeNull();
  });
});
