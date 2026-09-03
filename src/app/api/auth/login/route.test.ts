import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
import { resetRateLimits } from "@/lib/rate-limit";
import { createLoginHandler } from "./route";

const LOGIN_URL = "http://localhost/api/auth/login";
const EMAIL = "login-user@example.com";
const PASSWORD = "a-strong-password";

function postJson(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(LOGIN_URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/auth/login", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(async () => {
    resetRateLimits();
    ctx = createTestAuthService();
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: EMAIL,
      password: PASSWORD,
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
  });

  function handlerFor() {
    return withErrorHandling("auth_login", createLoginHandler(ctx.authService));
  }

  it("authenticates valid credentials, returns 200, and sets a session cookie", async () => {
    const response = await handlerFor()(postJson({ email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; email: string };
    expect(body.email).toBe(EMAIL);
    expect(readSetCookie(response, "p2p_session")).toBeTruthy();
  });

  it("rejects an invalid password with 401", async () => {
    const response = await handlerFor()(postJson({ email: EMAIL, password: "wrong-password" }));
    expect(response.status).toBe(401);
  });

  it("rejects a nonexistent account with the same 401 as a wrong password", async () => {
    const response = await handlerFor()(postJson({ email: "nobody@example.com", password: PASSWORD }));
    expect(response.status).toBe(401);
  });

  it("does not leak whether the failure was 'no such account' vs 'wrong password'", async () => {
    const wrongPassword = await handlerFor()(postJson({ email: EMAIL, password: "wrong" }));
    const noSuchAccount = await handlerFor()(
      postJson({ email: "nobody@example.com", password: PASSWORD }),
    );
    const bodyA = (await wrongPassword.json()) as { message: string };
    const bodyB = (await noSuchAccount.json()) as { message: string };
    expect(wrongPassword.status).toBe(noSuchAccount.status);
    expect(bodyA.message).toBe(bodyB.message);
  });

  it("rate-limits repeated login attempts against the same account", async () => {
    const handler = handlerFor();
    for (let i = 0; i < 8; i += 1) {
      const response = await handler(postJson({ email: EMAIL, password: "wrong" }));
      expect(response.status).toBe(401);
    }
    const blocked = await handler(postJson({ email: EMAIL, password: "wrong" }));
    expect(blocked.status).toBe(429);
  });
});
