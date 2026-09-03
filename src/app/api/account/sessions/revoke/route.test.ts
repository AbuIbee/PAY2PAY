import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
import { createRevokeSessionHandler } from "./route";

const REVOKE_URL = "http://localhost/api/account/sessions/revoke";

function postWithCookie(token: string | undefined, sessionId: string | undefined) {
  return new NextRequest(REVOKE_URL, {
    method: "POST",
    headers: {
      ...(token ? { cookie: `p2p_session=${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId }),
  });
}

describe("POST /api/account/sessions/revoke", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let token: string;
  let sessionId: string;

  beforeEach(async () => {
    ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "revoke-session-user@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    const validated = await ctx.authService.validateSession(token);
    sessionId = validated!.sessionId;
  });

  function handlerFor() {
    return withErrorHandling("account_sessions_revoke", createRevokeSessionHandler(ctx.authService));
  }

  it("rejects access with no session cookie (401)", async () => {
    const response = await handlerFor()(postWithCookie(undefined, sessionId));
    expect(response.status).toBe(401);
  });

  it("rejects a missing sessionId (400)", async () => {
    const response = await handlerFor()(postWithCookie(token, undefined));
    expect(response.status).toBe(400);
  });

  it("revokes a session that belongs to the caller and clears the cookie when it's the current one", async () => {
    const response = await handlerFor()(postWithCookie(token, sessionId));
    expect(response.status).toBe(200);
    expect(readSetCookie(response, "p2p_session")).toBe("");
    expect(await ctx.authService.validateSession(token)).toBeNull();
  });

  it("rejects revoking another user's session (IDOR) and does not clear the caller's cookie", async () => {
    const other = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "victim-session-user@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const otherValidated = await ctx.authService.validateSession(other.token);

    const response = await handlerFor()(postWithCookie(token, otherValidated!.sessionId));
    expect(response.status).toBe(401);
    expect(readSetCookie(response, "p2p_session")).toBeUndefined();
    // The victim's session must be untouched.
    expect(await ctx.authService.validateSession(other.token)).not.toBeNull();
  });
});
