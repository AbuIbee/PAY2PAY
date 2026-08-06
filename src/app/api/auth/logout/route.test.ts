import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
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
});
