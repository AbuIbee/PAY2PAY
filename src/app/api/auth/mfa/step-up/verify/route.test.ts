import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { resetRateLimits } from "@/lib/rate-limit";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { computeTotpCode } from "@/lib/auth/totp";
import { createStepUpVerifyHandler } from "./route";

function postWithCookie(body: unknown, token: string) {
  return new NextRequest("http://localhost/api/auth/mfa/step-up/verify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
  });
}

describe("POST /api/auth/mfa/step-up/verify", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;
  let userId: string;
  let secret: string;

  beforeEach(async () => {
    resetRateLimits();
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "stepup@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
    const enrollment = await mfaCtx.mfaService.beginTotpEnrollment(userId, "stepup@example.com");
    secret = enrollment.secret;
    await mfaCtx.mfaService.confirmTotpEnrollment(userId, computeTotpCode(secret));
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_mfa_step_up_verify",
      createStepUpVerifyHandler(authCtx.authService, mfaCtx.mfaService),
    );
  }

  it("passes with the correct TOTP code and grants a fresh step-up", async () => {
    const response = await handlerFor()(
      postWithCookie({ method: "totp", code: computeTotpCode(secret), action: "sign_agreement" }, token),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { passed: boolean };
    expect(body.passed).toBe(true);

    const sessionId = (await authCtx.authService.validateSession(token))?.sessionId as string;
    expect(await mfaCtx.mfaService.requireStepUp({ userId, sessionId, action: "sign_agreement" })).toBe(true);
  });

  it("fails with an incorrect code and returns 401 with passed: false", async () => {
    const response = await handlerFor()(
      postWithCookie({ method: "totp", code: "000000", action: "sign_agreement" }, token),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { passed: boolean };
    expect(body.passed).toBe(false);
  });

  it("rejects an unauthenticated request with 401 before even checking the code", async () => {
    const response = await handlerFor()(
      postWithCookie({ method: "totp", code: "123456", action: "sign_agreement" }, "not-a-real-token"),
    );
    expect(response.status).toBe(401);
  });
});
