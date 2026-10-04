import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createResourceAccessGetHandler } from "./route";

describe("GET /api/organizations/resource-access", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let organizationId: string;
  let viewerToken: string;
  let ownerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();

    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerToken = owner.token;

    const org = await orgCtx.businessProfiles.insert({
      ownerUserId: owner.user.id,
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: owner.user.id, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });

    const viewer = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "viewer@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    viewerToken = viewer.token;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: viewer.user.id, role: "VIEWER", customRoleId: null, isAuthorizedRepresentative: false });
    // "Final RBAC Authorization Cutover": no authorization-time self-healing — the explicit migration
    // step is what gives these legacy-role-seeded memberships a resolvable role_id at all.
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
  });

  function handler() {
    return withErrorHandling("test", createResourceAccessGetHandler(authCtx.authService, orgCtx.permissions));
  }

  function request(permission: string, token: string) {
    return new NextRequest(`http://localhost/api/organizations/resource-access?organizationId=${organizationId}&permission=${permission}`, {
      headers: { cookie: `p2p_session=${token}` },
    });
  }

  it("an ordinary member is allowed to read a non-sensitive resource (reports.view)", async () => {
    const response = await handler()(request("reports.view", viewerToken));
    expect((await response.json()) as { allowed: boolean }).toEqual({ allowed: true });
  });

  it("a VIEWER is denied a sensitive resource (integrations.view) — never granted just because they are an active member", async () => {
    const response = await handler()(request("integrations.view", viewerToken));
    expect((await response.json()) as { allowed: boolean }).toEqual({ allowed: false });
  });

  it("the OWNER is allowed every sensitive resource", async () => {
    const response = await handler()(request("integrations.view", ownerToken));
    expect((await response.json()) as { allowed: boolean }).toEqual({ allowed: true });
  });

  it("rejects an unrecognized permission key with 400", async () => {
    const response = await handler()(request("not-a-real-permission", ownerToken));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(
      new NextRequest(`http://localhost/api/organizations/resource-access?organizationId=${organizationId}&permission=reports.view`),
    );
    expect(response.status).toBe(401);
  });
});
