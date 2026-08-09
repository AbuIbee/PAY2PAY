import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createResendVerificationHandler } from "./route";

function postWithCookie(token?: string) {
  return new NextRequest("http://localhost/api/auth/resend-verification", {
    method: "POST",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("POST /api/auth/resend-verification", () => {
  let ctx: ReturnType<typeof createTestAuthService>;
  let token: string;
  const email = "resend@example.com";

  beforeEach(async () => {
    resetRateLimits();
    ctx = createTestAuthService();
    const result = await ctx.authService.signup({
      email,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling("auth_resend_verification", createResendVerificationHandler(ctx.authService));
  }

  it("sends another verification email for an authenticated, unverified user", async () => {
    const sentBefore = ctx.emailSender.sent.length;
    const response = await handlerFor()(postWithCookie(token));
    expect(response.status).toBe(200);
    expect(ctx.emailSender.sent.length).toBe(sentBefore + 1);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie());
    expect(response.status).toBe(401);
  });
});
