import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { computeTotpCode } from "@/lib/auth/totp";
import { createTotpConfirmHandler } from "../totp/confirm/route";
import { createTotpEnrollHandler } from "../totp/enroll/route";
import { createMfaStatusHandler } from "./route";

const URL = "http://localhost/api/auth/mfa/status";

function getWithCookie(token?: string) {
  return new NextRequest(URL, { headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET /api/auth/mfa/status", () => {
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
      email: "mfa-status@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling("auth_mfa_status", createMfaStatusHandler(authCtx.authService, mfaCtx.mfaService));
  }

  it("reports no enrolled methods before enrollment", async () => {
    const response = await handlerFor()(getWithCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { enrolled: boolean; methods: string[] };
    expect(body.enrolled).toBe(false);
    expect(body.methods).toEqual([]);
  });

  it("reports the verified method once TOTP enrollment is confirmed", async () => {
    await withErrorHandling(
      "auth_mfa_totp_enroll",
      createTotpEnrollHandler(authCtx.authService, mfaCtx.mfaService),
    )(new NextRequest("http://localhost/api/auth/mfa/totp/enroll", {
      method: "POST",
      headers: { cookie: `p2p_session=${token}` },
    }));
    const userId = (await authCtx.authService.validateSession(token))?.user.id as string;
    const credential = await mfaCtx.credentials.findLatestByUserAndMethod(userId, "totp");
    const code = computeTotpCode(credential?.secretRef as string);
    await withErrorHandling(
      "auth_mfa_totp_confirm",
      createTotpConfirmHandler(authCtx.authService, mfaCtx.mfaService),
    )(new NextRequest("http://localhost/api/auth/mfa/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
    }));

    const response = await handlerFor()(getWithCookie(token));
    const body = (await response.json()) as { enrolled: boolean; methods: string[] };
    expect(body.enrolled).toBe(true);
    expect(body.methods).toEqual(["totp"]);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(getWithCookie());
    expect(response.status).toBe(401);
  });
});
