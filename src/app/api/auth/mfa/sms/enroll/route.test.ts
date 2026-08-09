import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { createSmsEnrollHandler } from "./route";

const URL = "http://localhost/api/auth/mfa/sms/enroll";

function postWithCookie(body: unknown, token?: string) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `p2p_session=${token}` } : {}),
    },
  });
}

describe("POST /api/auth/mfa/sms/enroll", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      email: "sms-enroll@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
  });

  function handlerFor() {
    return withErrorHandling(
      "auth_mfa_sms_enroll",
      createSmsEnrollHandler(authCtx.authService, mfaCtx.mfaService),
    );
  }

  it("sends a code to the phone number and returns 200", async () => {
    const response = await handlerFor()(postWithCookie({ phoneNumber: "+15551234567" }, token));
    expect(response.status).toBe(200);
    expect(mfaCtx.smsSender.lastCodeFor("+15551234567")).toBeTruthy();
  });

  it("rejects a malformed phone number with 400", async () => {
    const response = await handlerFor()(postWithCookie({ phoneNumber: "not-a-phone" }, token));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie({ phoneNumber: "+15551234567" }));
    expect(response.status).toBe(401);
  });
});
