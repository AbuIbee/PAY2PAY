import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { computeTotpCode } from "@/lib/auth/totp";
import { createTotpEnrollHandler } from "../enroll/route";
import { createTotpConfirmHandler } from "./route";

const URL = "http://localhost/api/auth/mfa/totp/confirm";

function postWithCookie(body: unknown, token: string) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
  });
}

describe("POST /api/auth/mfa/totp/confirm", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "totp-confirm@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    await withErrorHandling(
      "auth_mfa_totp_enroll",
      createTotpEnrollHandler(authCtx.authService, mfaCtx.mfaService),
    )(new NextRequest("http://localhost/api/auth/mfa/totp/enroll", {
      method: "POST",
      headers: { cookie: `p2p_session=${token}` },
    }));
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_mfa_totp_confirm",
      createTotpConfirmHandler(authCtx.authService, mfaCtx.mfaService),
    );
  }

  it("confirms enrollment with the correct code and returns 200", async () => {
    const userId = (await authCtx.authService.validateSession(token))?.user.id as string;
    const credential = await mfaCtx.credentials.findLatestByUserAndMethod(userId, "totp");
    const code = computeTotpCode(credential?.secretRef as string);

    const response = await handlerFor()(postWithCookie({ code }, token));
    expect(response.status).toBe(200);
  });

  it("rejects an incorrect code with 400", async () => {
    const response = await handlerFor()(postWithCookie({ code: "000000" }, token));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie({ code: "123456" }, "not-a-real-token"));
    expect(response.status).toBe(401);
  });
});
