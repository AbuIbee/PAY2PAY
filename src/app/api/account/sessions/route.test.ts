import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createListSessionsHandler } from "./route";

const SESSIONS_URL = "http://localhost/api/account/sessions";

function getWithCookie(token?: string) {
  return new NextRequest(SESSIONS_URL, {
    method: "GET",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("GET /api/account/sessions", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let token: string;
  const email = "list-sessions-user@example.com";

  beforeEach(async () => {
    ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: "203.0.113.9",
      userAgent: "test-browser/1.0",
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling("account_sessions_list", createListSessionsHandler(ctx.authService));
  }

  it("rejects access with no session cookie (401)", async () => {
    const response = await handlerFor()(getWithCookie());
    expect(response.status).toBe(401);
  });

  it("returns the caller's session, marked as current, without exposing a token hash", async () => {
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ id: string; isCurrent: boolean; ipAddress: string | null; userAgent: string | null }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.isCurrent).toBe(true);
    expect(body.sessions[0]?.ipAddress).toBe("203.0.113.9");
    expect(body.sessions[0]?.userAgent).toBe("test-browser/1.0");
    expect(JSON.stringify(body)).not.toContain("sessionTokenHash");
  });

  it("never returns another user's sessions", async () => {
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "other-list-sessions-user@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });

    const response = await handlerFor()(getWithCookie(token));
    const body = (await response.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions).toHaveLength(1);
  });
});
