import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestAdminService } from "@/lib/admin/testFakes";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createAdminImpersonationActiveHandler } from "./route";

/**
 * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md) — proves the
 * route the global AdminImpersonationBanner polls actually surfaces an admin's own still-open
 * support view (or null), and follows the same 401/403 negative pattern as every other admin route.
 */
describe("GET /api/admin/impersonation/active", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let adminCtx: ReturnType<typeof createTestAdminService>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    adminCtx = createTestAdminService();
  });

  function handler() {
    return withErrorHandling("admin_impersonation_active", createAdminImpersonationActiveHandler(authCtx.authService, adminCtx.adminService));
  }

  function withCookie(sessionToken?: string) {
    return new NextRequest("http://localhost/api/admin/impersonation/active", {
      headers: sessionToken ? { cookie: `p2p_session=${sessionToken}` } : {},
    });
  }

  it("rejects a request with no session (401)", async () => {
    const response = await handler()(withCookie());
    expect(response.status).toBe(401);
  });

  it("rejects an ordinary Member's genuine session (403)", async () => {
    const result = await authCtx.authService.signup({ email: "member@example.com", password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    const response = await handler()(withCookie(result.token));
    expect(response.status).toBe(403);
  });

  it("returns { active: null } for a Platform Admin with no open support view", async () => {
    const result = await authCtx.authService.signup({ email: "admin@example.com", password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    authCtx.users.setPlatformRole(result.user.id, "platform_admin");
    const response = await handler()(withCookie(result.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { active: unknown };
    expect(body.active).toBeNull();
  });

  it("surfaces an admin's own still-open support view", async () => {
    const authResult = await authCtx.authService.signup({ email: "admin2@example.com", password: "a-strong-password", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH, ipAddress: null, userAgent: null });
    authCtx.users.setPlatformRole(authResult.user.id, "platform_admin");
    const validated = await authCtx.authService.validateSession(authResult.token);
    const sessionId = validated!.sessionId;

    // Seed the same admin identity directly into adminCtx's own repos (AdminService's own directory
    // and mfa/step-up state live there) — same split as businesses/route.test.ts's own comment
    // explains, since AdminService trusts the session-derived actingUserId rather than re-resolving
    // it from its own user repo.
    adminCtx.users.byId.set(authResult.user.id, {
      id: authResult.user.id,
      email: "admin2@example.com",
      authCredentialRef: "x",
      status: "active",
      platformRole: "platform_admin",
      accountClassification: "production",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      emailVerifiedAt: null,
    });
    const target = await adminCtx.users.insert({ email: "target@example.com", authCredentialRef: "x", dateOfBirth: TEST_ADULT_DATE_OF_BIRTH });
    await grantStepUp({ mfaCredentials: adminCtx.mfaCredentials, stepUps: adminCtx.stepUps }, authResult.user.id, sessionId);
    await adminCtx.adminService.startImpersonation(
      { actingUserId: authResult.user.id, actingSessionId: sessionId, actingRole: "platform_admin", ipAddress: null, deviceInfo: null },
      target.id,
      "checking a ticket",
    );

    const response = await handler()(withCookie(authResult.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { active: { targetUserId: string } | null };
    expect(body.active?.targetUserId).toBe(target.id);
  });
});
