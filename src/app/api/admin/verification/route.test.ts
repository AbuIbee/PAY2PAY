import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { createAdminVerificationListHandler } from "./route";

async function signupAs(authCtx: ReturnType<typeof createTestAuthService>, email: string, role: "member" | "platform_admin" | "platform_owner") {
  const user = await authCtx.authService.signup({
    accountType: "personal",
    identity: TEST_SIGNUP_IDENTITY,
    inviteCode: null,
    email,
    password: "a-strong-password",
    dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
    ipAddress: null,
    userAgent: null,
  });
  if (role !== "member") authCtx.users.setPlatformRole(user.user.id, role);
  return user;
}

describe("GET /api/admin/verification", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const { verificationService } = createTestVerificationService();
    const response = await withErrorHandling("admin_verification_list", createAdminVerificationListHandler(authCtx.authService, verificationService))(
      new NextRequest("http://localhost/api/admin/verification"),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a non-admin member with 403", async () => {
    const authCtx = createTestAuthService();
    const { verificationService } = createTestVerificationService();
    const user = await signupAs(authCtx, "member@example.com", "member");
    const response = await withErrorHandling("admin_verification_list", createAdminVerificationListHandler(authCtx.authService, verificationService))(
      new NextRequest("http://localhost/api/admin/verification", { headers: { cookie: `p2p_session=${user.token}` } }),
    );
    expect(response.status).toBe(403);
  });

  it("allows a platform owner to list every pending verification request", async () => {
    const authCtx = createTestAuthService();
    const { verificationService, profileOwners } = createTestVerificationService();
    const owner = await signupAs(authCtx, "owner@example.com", "platform_owner");
    profileOwners.set("personal", "profile-1", "some-other-user");
    await verificationService.submitFullVerificationRequest("personal", "profile-1");

    const response = await withErrorHandling("admin_verification_list", createAdminVerificationListHandler(authCtx.authService, verificationService))(
      new NextRequest("http://localhost/api/admin/verification", { headers: { cookie: `p2p_session=${owner.token}` } }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].profileId).toBe("profile-1");
  });
});
