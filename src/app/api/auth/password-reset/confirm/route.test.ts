import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createPasswordResetConfirmHandler } from "./route";

const URL = "http://localhost/api/auth/password-reset/confirm";
const EMAIL = "confirm-route@example.com";

function postJson(body: unknown) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/auth/password-reset/confirm", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(async () => {
    resetRateLimits();
    ctx = createTestAuthService();
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: EMAIL,
      password: "original-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    await ctx.authService.requestPasswordReset(EMAIL, { ipAddress: null, userAgent: null });
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_password_reset_confirm",
      createPasswordResetConfirmHandler(ctx.authService),
    );
  }

  it("resets the password with a valid token and returns 200", async () => {
    const token = ctx.emailSender.lastTokenFor(EMAIL) as string;
    const response = await handlerFor()(postJson({ token, password: "a-brand-new-password" }));
    expect(response.status).toBe(200);

    const login = await ctx.authService.login({
      email: EMAIL,
      password: "a-brand-new-password",
      ipAddress: null,
      userAgent: null,
    });
    expect(login.user.email).toBe(EMAIL);
  });

  it("rejects an invalid token with 400", async () => {
    const response = await handlerFor()(postJson({ token: "not-a-real-token", password: "a-brand-new-password" }));
    expect(response.status).toBe(400);
  });

  it("rejects a too-short password with 400", async () => {
    const token = ctx.emailSender.lastTokenFor(EMAIL) as string;
    const response = await handlerFor()(postJson({ token, password: "short" }));
    expect(response.status).toBe(400);
  });

  it("rejects reusing an already-consumed token with 400", async () => {
    const token = ctx.emailSender.lastTokenFor(EMAIL) as string;
    await handlerFor()(postJson({ token, password: "a-brand-new-password" }));
    const second = await handlerFor()(postJson({ token, password: "yet-another-password" }));
    expect(second.status).toBe(400);
  });
});
