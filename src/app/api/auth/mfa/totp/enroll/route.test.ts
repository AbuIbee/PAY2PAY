import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { createTotpEnrollHandler } from "./route";

const URL = "http://localhost/api/auth/mfa/totp/enroll";

function postWithCookie(token?: string) {
  return new NextRequest(URL, {
    method: "POST",
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("POST /api/auth/mfa/totp/enroll", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      email: "totp-enroll@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_mfa_totp_enroll",
      createTotpEnrollHandler(authCtx.authService, mfaCtx.mfaService),
    );
  }

  it("returns a secret and otpauth URI for a signed-in user", async () => {
    const response = await handlerFor()(postWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { secret: string; otpauthUri: string };
    expect(body.secret).toBeTruthy();
    expect(body.otpauthUri).toContain("otpauth://totp/");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie());
    expect(response.status).toBe(401);
  });
});
