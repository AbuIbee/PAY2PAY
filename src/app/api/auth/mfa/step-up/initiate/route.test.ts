import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { computeTotpCode } from "@/lib/auth/totp";
import { createStepUpInitiateHandler } from "./route";

function postWithCookie(body: unknown, token: string) {
  return new NextRequest("http://localhost/api/auth/mfa/step-up/initiate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
  });
}

describe("POST /api/auth/mfa/step-up/initiate", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      email: "stepup-initiate@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    userId = result.user.id;
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_mfa_step_up_initiate",
      createStepUpInitiateHandler(authCtx.authService, mfaCtx.mfaService),
    );
  }

  it("sends an SMS code when the user has SMS enrolled", async () => {
    await mfaCtx.mfaService.beginSmsEnrollment(userId, "+15551112222");
    await mfaCtx.mfaService.confirmSmsEnrollment(userId, mfaCtx.smsSender.lastCodeFor("+15551112222") as string);

    const response = await handlerFor()(postWithCookie({ method: "sms" }, token));
    expect(response.status).toBe(200);
    expect(mfaCtx.smsSender.sent.length).toBeGreaterThanOrEqual(2); // enrollment code + step-up code
  });

  it("no-ops for totp (nothing to send)", async () => {
    const { secret } = await mfaCtx.mfaService.beginTotpEnrollment(userId, "stepup-initiate@example.com");
    await mfaCtx.mfaService.confirmTotpEnrollment(userId, computeTotpCode(secret));

    const response = await handlerFor()(postWithCookie({ method: "totp" }, token));
    expect(response.status).toBe(200);
  });

  it("rejects when SMS is not an enrolled method", async () => {
    const response = await handlerFor()(postWithCookie({ method: "sms" }, token));
    expect(response.status).toBe(400);
  });
});
