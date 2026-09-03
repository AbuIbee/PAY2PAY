import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { computeTotpCode } from "@/lib/auth/totp";
import { createTotpEnrollHandler } from "../totp/enroll/route";
import { createTotpConfirmHandler } from "../totp/confirm/route";
import { createMfaDisableHandler } from "./route";

const URL = "http://localhost/api/auth/mfa/disable";

function postWithCookie(body: unknown, token: string) {
  return new NextRequest(URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
  });
}

/**
 * Section B (closed-beta remediation, Product Owner review): MfaService.disableMethod previously had
 * no caller anywhere in the codebase — there was no way to remove an enrolled MFA method at all. This
 * route is that path: self-service, step-up gated (removing your own security control requires
 * proving you still have it).
 */
describe("POST /api/auth/mfa/disable", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let mfaCtx: ReturnType<typeof createTestMfaService>;
  let token: string;
  let userId: string;
  let sessionId: string;
  let secret: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    mfaCtx = createTestMfaService();
    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "mfa-disable@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    const session = await authCtx.authService.validateSession(token);
    userId = session?.user.id as string;
    sessionId = session?.sessionId as string;

    await withErrorHandling(
      "auth_mfa_totp_enroll",
      createTotpEnrollHandler(authCtx.authService, mfaCtx.mfaService),
    )(new NextRequest("http://localhost/api/auth/mfa/totp/enroll", { method: "POST", headers: { cookie: `p2p_session=${token}` } }));
    const credential = await mfaCtx.credentials.findLatestByUserAndMethod(userId, "totp");
    secret = credential?.secretRef as string;
    await withErrorHandling(
      "auth_mfa_totp_confirm",
      createTotpConfirmHandler(authCtx.authService, mfaCtx.mfaService),
    )(new NextRequest("http://localhost/api/auth/mfa/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ code: computeTotpCode(secret) }),
      headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
    }));
  });

  function handlerFor() {
    return withErrorHandling("auth_mfa_disable", createMfaDisableHandler(authCtx.authService, mfaCtx.mfaService));
  }

  it("rejects disabling a method without a fresh step-up (403)", async () => {
    const response = await handlerFor()(postWithCookie({ method: "totp" }, token));
    expect(response.status).toBe(403);
    expect(await mfaCtx.mfaService.hasVerifiedMethod(userId)).toBe(true);
  });

  it("disables an enrolled method once a fresh step-up exists (200)", async () => {
    const passed = await mfaCtx.mfaService.completeStepUp({ userId, sessionId, method: "totp", code: computeTotpCode(secret), action: "mfa_disable" });
    expect(passed).toBe(true);

    const response = await handlerFor()(postWithCookie({ method: "totp" }, token));
    expect(response.status).toBe(200);
    expect(await mfaCtx.mfaService.hasVerifiedMethod(userId)).toBe(false);
  });

  it("rejects an unenrolled method with 400, even with a fresh step-up", async () => {
    await mfaCtx.mfaService.completeStepUp({ userId, sessionId, method: "totp", code: computeTotpCode(secret), action: "mfa_disable" });

    const response = await handlerFor()(postWithCookie({ method: "sms" }, token));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handlerFor()(postWithCookie({ method: "totp" }, "not-a-real-token"));
    expect(response.status).toBe(401);
  });
});
