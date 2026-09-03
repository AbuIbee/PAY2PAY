import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createVerifyEmailHandler } from "./route";

const URL = "http://localhost/api/auth/verify-email";

function postJson(body: unknown) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/auth/verify-email", () => {
  let ctx: ReturnType<typeof createTestAuthService>;

  beforeEach(async () => {
    resetRateLimits();
    ctx = createTestAuthService();
    await ctx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "verify-route@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
  });

  function handlerFor() {
    return withErrorHandling("auth_verify_email", createVerifyEmailHandler(ctx.authService));
  }

  it("verifies with the emailed token and returns 200", async () => {
    const token = ctx.emailSender.lastTokenFor("verify-route@example.com") as string;
    const response = await handlerFor()(postJson({ token }));
    expect(response.status).toBe(200);
  });

  it("rejects an invalid token with 400", async () => {
    const response = await handlerFor()(postJson({ token: "not-a-real-token" }));
    expect(response.status).toBe(400);
  });

  it("rejects a missing token with 400", async () => {
    const response = await handlerFor()(postJson({}));
    expect(response.status).toBe(400);
  });
});
