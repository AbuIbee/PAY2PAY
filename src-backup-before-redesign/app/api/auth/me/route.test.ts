import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestAuthService } from "@/lib/auth/testFakes";
import { createMeHandler } from "./route";

const ME_URL = "http://localhost/api/auth/me";

function getWithCookie(token?: string) {
  return new NextRequest(ME_URL, {
    method: "GET",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("GET /api/auth/me (protected route)", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let token: string;
  const email = "protected-route-user@example.com";

  beforeEach(async () => {
    ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      email,
      password: "a-strong-password",
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling("auth_me", createMeHandler(ctx.authService));
  }

  it("returns the caller's identity for a valid session", async () => {
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; email: string };
    expect(body.email).toBe(email);
  });

  it("rejects access with no session cookie (401)", async () => {
    const response = await handlerFor()(getWithCookie());
    expect(response.status).toBe(401);
  });

  it("rejects access with an unknown/garbage token (401)", async () => {
    const response = await handlerFor()(getWithCookie("not-a-real-token"));
    expect(response.status).toBe(401);
  });

  it("rejects access once the session has been revoked (logout)", async () => {
    await ctx.authService.logout(token);
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(401);
  });

  it("stays authenticated across repeated requests with the same session (persistence)", async () => {
    const handler = handlerFor();
    const first = await handler(getWithCookie(token));
    const second = await handler(getWithCookie(token));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
