import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestProfileAccessService, createTestVerificationService } from "@/lib/profiles/testFakes";
import { createVerificationGetHandler, createVerificationSubmitHandler } from "./route";

const URL = "http://localhost/api/profiles/verification";

function withCookie(token?: string) {
  return new NextRequest(URL, { headers: token ? { cookie: `p2p_session=${token}` } : {} });
}

describe("GET/POST /api/profiles/verification", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let accessCtx: ReturnType<typeof createTestProfileAccessService>;
  let verificationCtx: ReturnType<typeof createTestVerificationService>;
  let token: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    accessCtx = createTestProfileAccessService();
    verificationCtx = createTestVerificationService();
    const result = await authCtx.authService.signup({
      email: "verify-route@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    token = result.token;
    await accessCtx.personalProfiles.insert(result.user.id);
  });

  function getHandler() {
    return withErrorHandling(
      "profiles_verification_get",
      createVerificationGetHandler(authCtx.authService, accessCtx.profileAccessService, verificationCtx.verificationService),
    );
  }

  function postHandler() {
    return withErrorHandling(
      "profiles_verification_submit",
      createVerificationSubmitHandler(authCtx.authService, accessCtx.profileAccessService, verificationCtx.verificationService),
    );
  }

  it("reports UNVERIFIED for a brand-new personal profile", async () => {
    const response = await getHandler()(withCookie(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { profileKind: string; state: string };
    expect(body.profileKind).toBe("personal");
    expect(body.state).toBe("UNVERIFIED");
  });

  it("moves to FULL_PENDING after submitting a verification request, visible on the next GET", async () => {
    const postResponse = await postHandler()(new NextRequest(URL, { method: "POST", headers: { cookie: `p2p_session=${token}` } }));
    expect(postResponse.status).toBe(200);

    const getResponse = await getHandler()(withCookie(token));
    const body = (await getResponse.json()) as { state: string };
    expect(body.state).toBe("FULL_PENDING");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await getHandler()(withCookie());
    expect(response.status).toBe(401);
  });

  it(
    "PRSprint 22 (docs/prsprints/PRSPRINT_22_KYC_KYB_FINANCIAL_ACCOUNT_PROVISIONING.md): a client-supplied " +
      "'status'/'decision' field in the submit body is completely ignored — the route never even reads the " +
      "request body, so a request only ever lands at FULL_PENDING, never a self-reported FULL_VERIFIED",
    async () => {
      const postResponse = await postHandler()(
        new NextRequest(URL, {
          method: "POST",
          headers: { cookie: `p2p_session=${token}`, "content-type": "application/json" },
          body: JSON.stringify({ status: "verified", decision: "verified", tier: "full", state: "FULL_VERIFIED" }),
        }),
      );
      expect(postResponse.status).toBe(200);

      const getResponse = await getHandler()(withCookie(token));
      const body = (await getResponse.json()) as { state: string };
      expect(body.state).toBe("FULL_PENDING");
      expect(body.state).not.toBe("FULL_VERIFIED");
    },
  );
});
