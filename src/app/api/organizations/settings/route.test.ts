import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { PricingService } from "@/lib/pricing/pricingService";
import { InMemoryPricingPlanRepository, InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { createOrganizationSettingsGetHandler } from "./route";

describe("GET /api/organizations/settings", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let pricing: PricingService;
  let organizationId: string;
  let ownerUserId: string;
  let ownerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    pricing = new PricingService(new InMemoryPricingPlanRepository(), new InMemorySubscriptionRepository());

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
    ownerUserId = result.user.id;
    ownerToken = result.token;

    const org = await orgCtx.businessProfiles.insert({
      ownerUserId,
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: ownerUserId, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });
    // "Final RBAC Authorization Cutover": no authorization-time self-healing — the explicit migration
    // step is what gives this legacy-role-seeded membership a resolvable role_id at all.
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
  });

  function handler() {
    return withErrorHandling("test", createOrganizationSettingsGetHandler(authCtx.authService, orgCtx.permissions, orgCtx.businessProfiles, pricing));
  }

  function request(orgId: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/settings?organizationId=${orgId}`, {
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("the OWNER can view organization settings", async () => {
    const response = await handler()(request(organizationId, ownerToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { legalBusinessName: string; plan: unknown };
    expect(body.legalBusinessName).toBe("ABC Trucking LLC");
    expect(body.plan).toBeNull();
  });

  it("a VIEWER member is denied — organization_settings requires manage_organization_settings, not plain membership", async () => {
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
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: viewer.user.id, role: "VIEWER", customRoleId: null, isAuthorizedRepresentative: false });
    const response = await handler()(request(organizationId, viewer.token));
    expect(response.status).toBe(403);
  });

  it("a FINANCE_ADMIN member is also denied — org settings administration is OWNER-only by design, never inferred from a role 'looking privileged'", async () => {
    const financeAdmin = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "finance@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: financeAdmin.user.id, role: "FINANCE_ADMIN", customRoleId: null, isAuthorizedRepresentative: false });
    const response = await handler()(request(organizationId, financeAdmin.token));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(request(organizationId));
    expect(response.status).toBe(401);
  });
});
