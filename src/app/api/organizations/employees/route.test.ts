import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createOrganizationEmployeesGetHandler } from "./route";

describe("GET /api/organizations/employees", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let organizationId: string;
  let memberUserId: string;
  let memberToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();

    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    memberUserId = result.user.id;
    memberToken = result.token;
    orgCtx.userEmails.set(memberUserId, "owner@example.com");

    const org = await orgCtx.businessProfiles.insert({
      ownerUserId: memberUserId,
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: memberUserId, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
  });

  function handler() {
    return withErrorHandling("test", createOrganizationEmployeesGetHandler(authCtx.authService, orgCtx.permissions, orgCtx.staffMembers, orgCtx.userEmails, orgCtx.roles));
  }

  function request(orgId: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/employees?organizationId=${orgId}`, {
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("an active member can list the organization's team members, with a plain display label (never used for authorization)", async () => {
    const response = await handler()(request(organizationId, memberToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ email: string | null; roleName: string; isOwnerRole: boolean; isAuthorizedRepresentative: boolean }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.email).toBe("owner@example.com");
    expect(body.items[0]!.roleName).toBe("Owner");
    expect(body.items[0]!.isOwnerRole).toBe(true);
    expect(body.items[0]!.isAuthorizedRepresentative).toBe(true);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(request(organizationId));
    expect(response.status).toBe(401);
  });

  it("denies a non-member with 403", async () => {
    const outsider = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "outsider@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(request(organizationId, outsider.token));
    expect(response.status).toBe(403);
  });
});
