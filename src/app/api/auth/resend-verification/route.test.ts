import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createResendVerificationHandler } from "./route";

function postWithCookie(token?: string, body?: unknown) {
  return new NextRequest("http://localhost/api/auth/resend-verification", {
    method: "POST",
    headers: {
      ...(token ? { cookie: `p2p_session=${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

  it("sends another verification email for an authenticated, unverified user, and returns a clear success response", async () => {
    const sentBefore = ctx.emailSender.sent.length;
    const response = await handlerFor()(postWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
    expect(ctx.emailSender.sent.length).toBe(sentBefore + 1);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie());
    expect(response.status).toBe(401);
  });

  it("sends the email to the authenticated user's own registered address, never an arbitrary one — a body-supplied 'email' field is ignored entirely (the route never reads a request body)", async () => {
    const response = await handlerFor()(postWithCookie(token, { email: "attacker-controlled@example.com" }));
    expect(response.status).toBe(200);
    const sentToAttacker = ctx.emailSender.sent.some((m) => m.to === "attacker-controlled@example.com");
    const sentToRealUser = ctx.emailSender.sent.some((m) => m.to === email);
    expect(sentToAttacker).toBe(false);
    expect(sentToRealUser).toBe(true);
  });

  it("Agreement Lifecycle V2 UAT: handles an already-verified user safely — 200, but no new email is sent (quiet no-op)", async () => {
    const session = await ctx.authService.validateSession(token);
    await ctx.users.markEmailVerified(session!.user.id);
    const sentBefore = ctx.emailSender.sent.length;

    const response = await handlerFor()(postWithCookie(token));
    expect(response.status).toBe(200);
    expect(ctx.emailSender.sent.length).toBe(sentBefore);
  });

  it("Agreement Lifecycle V2 UAT: the resent verification link uses the correct deployed URL, never localhost, reusing the same centralized APP_URL resolution as invitation emails", async () => {
    const deployedCtx = createTestAuthService(undefined, "https://pay-2-pay-git-some-branch-pay2-pay.vercel.app");
    const result = await deployedCtx.authService.signup({
      email: "deployed-user@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const deployedHandler = withErrorHandling("auth_resend_verification", createResendVerificationHandler(deployedCtx.authService));
    const response = await deployedHandler(postWithCookie(result.token));
    expect(response.status).toBe(200);

    const sent = deployedCtx.emailSender.sent.at(-1);
    expect(sent?.body).toContain("https://pay-2-pay-git-some-branch-pay2-pay.vercel.app/verify-email?token=");
    expect(sent?.body).not.toContain("localhost");
  });

  it("Agreement Lifecycle V2 UAT: existing rate limiting remains intact — the 6th resend within the window is rejected", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await handlerFor()(postWithCookie(token));
      expect(response.status).toBe(200);
    }
    const sixth = await handlerFor()(postWithCookie(token));
    expect(sixth.status).toBe(429);
  });
});
