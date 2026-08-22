import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestBetaInviteService } from "@/lib/compliance/testFakes";
import { createBetaInvitesGenerateHandler, createBetaInvitesListHandler } from "./route";

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

describe("POST /api/admin/beta-invites", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const authCtx = createTestAuthService();
    const { betaInviteService } = createTestBetaInviteService();
    const response = await withErrorHandling("admin_beta_invites_generate", createBetaInvitesGenerateHandler(authCtx.authService, betaInviteService))(
      new NextRequest("http://localhost/api/admin/beta-invites", { method: "POST", body: JSON.stringify({ code: "WELCOME1" }) }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a non-admin member with 403", async () => {
    const authCtx = createTestAuthService();
    const { betaInviteService } = createTestBetaInviteService();
    const user = await signupAs(authCtx, "member@example.com", "member");
    const response = await withErrorHandling("admin_beta_invites_generate", createBetaInvitesGenerateHandler(authCtx.authService, betaInviteService))(
      new NextRequest("http://localhost/api/admin/beta-invites", {
        method: "POST",
        body: JSON.stringify({ code: "WELCOME1" }),
        headers: { cookie: `p2p_session=${user.token}` },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("allows a platform admin to generate a code", async () => {
    const authCtx = createTestAuthService();
    const { betaInviteService } = createTestBetaInviteService();
    const admin = await signupAs(authCtx, "admin@example.com", "platform_admin");
    const response = await withErrorHandling("admin_beta_invites_generate", createBetaInvitesGenerateHandler(authCtx.authService, betaInviteService))(
      new NextRequest("http://localhost/api/admin/beta-invites", {
        method: "POST",
        body: JSON.stringify({ code: "WELCOME1", note: "batch 1" }),
        headers: { cookie: `p2p_session=${admin.token}` },
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.code.code).toBe("WELCOME1");
  });
});

describe("GET /api/admin/beta-invites", () => {
  it("rejects a non-admin member with 403", async () => {
    const authCtx = createTestAuthService();
    const { betaInviteService } = createTestBetaInviteService();
    const user = await signupAs(authCtx, "member2@example.com", "member");
    const response = await withErrorHandling("admin_beta_invites_list", createBetaInvitesListHandler(authCtx.authService, betaInviteService))(
      new NextRequest("http://localhost/api/admin/beta-invites", { headers: { cookie: `p2p_session=${user.token}` } }),
    );
    expect(response.status).toBe(403);
  });

  it("lists codes for a platform admin", async () => {
    const authCtx = createTestAuthService();
    const { betaInviteService, invites } = createTestBetaInviteService();
    await invites.insert({ code: "SEEDED1", createdByUserId: "admin-1", note: null });
    const admin = await signupAs(authCtx, "admin2@example.com", "platform_admin");
    const response = await withErrorHandling("admin_beta_invites_list", createBetaInvitesListHandler(authCtx.authService, betaInviteService))(
      new NextRequest("http://localhost/api/admin/beta-invites", { headers: { cookie: `p2p_session=${admin.token}` } }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.codes).toHaveLength(1);
  });
});
