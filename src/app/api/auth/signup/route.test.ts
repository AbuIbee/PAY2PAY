import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService, readSetCookie } from "@/lib/auth/testFakes";
import { createSignupHandler } from "./route";

const SIGNUP_URL = "http://localhost/api/auth/signup";
const dateOfBirth = TEST_ADULT_DATE_OF_BIRTH;

function postJson(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(SIGNUP_URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/auth/signup", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(() => {
    resetRateLimits();
    ctx = createTestAuthService();
  });

  // Wraps the same withErrorHandling the production route uses, so thrown
  // AppErrors are asserted via their mapped status code, exactly as a real
  // client would observe them.
  function handlerFor(authService = ctx.authService) {
    return withErrorHandling("auth_signup", createSignupHandler(authService));
  }

  it("creates an account, returns 201, and sets a session cookie", async () => {
    const handler = handlerFor();
    const response = await handler(
      postJson({ email: "new@example.com", password: "a-strong-password", dateOfBirth }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; email: string };
    expect(body.email).toBe("new@example.com");
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("authCredentialRef");

    const cookieValue = readSetCookie(response, "p2p_session");
    expect(cookieValue).toBeTruthy();
  });

  it("rejects a duplicate account with 409", async () => {
    const handler = handlerFor();
    await handler(postJson({ email: "dupe@example.com", password: "a-strong-password", dateOfBirth }));
    const second = await handler(
      postJson({ email: "dupe@example.com", password: "a-different-password", dateOfBirth }),
    );
    expect(second.status).toBe(409);
  });

  it("rejects an invalid password with 400", async () => {
    const handler = handlerFor();
    const response = await handler(postJson({ email: "shortpw@example.com", password: "short", dateOfBirth }));
    expect(response.status).toBe(400);
  });

  it("rejects a malformed email with 400", async () => {
    const handler = handlerFor();
    const response = await handler(
      postJson({ email: "not-an-email", password: "a-strong-password", dateOfBirth }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a missing/malformed date of birth with 400", async () => {
    const handler = handlerFor();
    const response = await handler(
      postJson({ email: "nodob@example.com", password: "a-strong-password", dateOfBirth: "not-a-date" }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects signup for someone under 18 with 400", async () => {
    const handler = handlerFor();
    const fifteenYearsAgo = new Date();
    fifteenYearsAgo.setUTCFullYear(fifteenYearsAgo.getUTCFullYear() - 15);
    const isoDob = fifteenYearsAgo.toISOString().slice(0, 10);

    const response = await handler(
      postJson({ email: "minor@example.com", password: "a-strong-password", dateOfBirth: isoDob }),
    );
    expect(response.status).toBe(400);
  });

  it("never returns a raw session token in the JSON body", async () => {
    const handler = handlerFor();
    const response = await handler(
      postJson({ email: "leak-check@example.com", password: "a-strong-password", dateOfBirth }),
    );
    const text = await response.clone().text();
    const cookieToken = readSetCookie(response, "p2p_session");
    expect(cookieToken).toBeTruthy();
    expect(text).not.toContain(cookieToken as string);
  });

  it("rate-limits repeated signups from the same IP", async () => {
    const handler = handlerFor();
    const headers = { "x-forwarded-for": "203.0.113.5" };
    for (let i = 0; i < 5; i += 1) {
      const response = await handler(
        postJson({ email: `rl-${i}@example.com`, password: "a-strong-password", dateOfBirth }, headers),
      );
      expect(response.status).toBe(201);
    }
    const blocked = await handler(
      postJson({ email: "rl-blocked@example.com", password: "a-strong-password", dateOfBirth }, headers),
    );
    expect(blocked.status).toBe(429);
  });
});
