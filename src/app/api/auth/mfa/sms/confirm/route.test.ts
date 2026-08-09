import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { createSmsEnrollHandler } from "../enroll/route";
import { createSmsConfirmHandler } from "./route";

function postWithCookie(url: string, body: unknown, token: string) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
  });
}

describe("POST /api/auth/mfa/sms/confirm", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;
  const phoneNumber = "+15557654321";

  beforeEach(async () => {
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      email: "sms-confirm@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    await withErrorHandling(
      "auth_mfa_sms_enroll",
      createSmsEnrollHandler(authCtx.authService, mfaCtx.mfaService),
    )(postWithCookie("http://localhost/api/auth/mfa/sms/enroll", { phoneNumber }, token));
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_mfa_sms_confirm",
      createSmsConfirmHandler(authCtx.authService, mfaCtx.mfaService),
    );
  }

  it("confirms enrollment with the correct code and returns 200", async () => {
    const code = mfaCtx.smsSender.lastCodeFor(phoneNumber) as string;
    const response = await handlerFor()(
      postWithCookie("http://localhost/api/auth/mfa/sms/confirm", { code }, token),
    );
    expect(response.status).toBe(200);
  });

  it("rejects an incorrect code with 400", async () => {
    const response = await handlerFor()(
      postWithCookie("http://localhost/api/auth/mfa/sms/confirm", { code: "000000" }, token),
    );
    expect(response.status).toBe(400);
  });
});
