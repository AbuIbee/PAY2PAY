import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { createAdminVerificationDecideHandler } from "./route";

async function signupAs(authCtx: ReturnType<typeof createTestAuthService>, email: string, role: "member" | "platform_admin" | "platform_owner") {
  const user = await authCtx.authService.signup({
    email,
    password: "a-strong-password",
    dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
    ipAddress: null,
    userAgent: null,
  });
  if (role !== "member") authCtx.users.setPlatformRole(user.user.id, role);
  return user;
}

function post(body: unknown, token?: string) {
  return new NextRequest("http://localhost/api/admin/verification/decide", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/verification/decide", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const { verificationService } = createTestVerificationService();
    const response = await withErrorHandling("admin_verification_decide", createAdminVerificationDecideHandler(authCtx.authService, verificationService))(
      post({ profileKind: "personal", profileId: randomUUID(), decision: "verified" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a non-admin member with 403", async () => {
    const authCtx = createTestAuthService();
    const { verificationService } = createTestVerificationService();
    const user = await signupAs(authCtx, "member@example.com", "member");
    const response = await withErrorHandling("admin_verification_decide", createAdminVerificationDecideHandler(authCtx.authService, verificationService))(
      post({ profileKind: "personal", profileId: randomUUID(), decision: "verified" }, user.token),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a rejection with no reason", async () => {
    const authCtx = createTestAuthService();
    const { verificationService, profileOwners } = createTestVerificationService();
    const owner = await signupAs(authCtx, "owner@example.com", "platform_owner");
    const profileId = randomUUID();
    profileOwners.set("personal", profileId, "some-other-user");
    await verificationService.submitFullVerificationRequest("personal", profileId);

    const response = await withErrorHandling("admin_verification_decide", createAdminVerificationDecideHandler(authCtx.authService, verificationService))(
      post({ profileKind: "personal", profileId, decision: "rejected" }, owner.token),
    );
    expect(response.status).toBe(400);
  });

  it("allows a platform owner to approve a pending request, unblocking isFullyVerified", async () => {
    const authCtx = createTestAuthService();
    const { verificationService, profileOwners } = createTestVerificationService();
    const owner = await signupAs(authCtx, "owner@example.com", "platform_owner");
    const profileId = randomUUID();
    profileOwners.set("personal", profileId, "some-other-user");
    await verificationService.submitFullVerificationRequest("personal", profileId);

    const response = await withErrorHandling("admin_verification_decide", createAdminVerificationDecideHandler(authCtx.authService, verificationService))(
      post({ profileKind: "personal", profileId, decision: "verified", reason: "Documents checked." }, owner.token),
    );
    expect(response.status).toBe(200);
    expect(await verificationService.isFullyVerified("personal", profileId)).toBe(true);
  });

  it("rejects an owner reviewing their own profile's request", async () => {
    const authCtx = createTestAuthService();
    const { verificationService, profileOwners } = createTestVerificationService();
    const owner = await signupAs(authCtx, "owner@example.com", "platform_owner");
    const profileId = randomUUID();
    profileOwners.set("personal", profileId, owner.user.id);
    await verificationService.submitFullVerificationRequest("personal", profileId);

    const response = await withErrorHandling("admin_verification_decide", createAdminVerificationDecideHandler(authCtx.authService, verificationService))(
      post({ profileKind: "personal", profileId, decision: "verified" }, owner.token),
    );
    expect(response.status).toBe(400);
  });
});
