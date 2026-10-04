import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { InMemoryBusinessObligationRepository, createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createOrganizationBalancesGetHandler } from "./route";

describe("GET /api/organizations/balances", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let obligations: InMemoryBusinessObligationRepository;
  let organizationId: string;
  let memberUserId: string;
  let memberToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    obligations = new InMemoryBusinessObligationRepository();

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
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: memberUserId, role: "VIEWER", customRoleId: null, isAuthorizedRepresentative: false });
    // "Final RBAC Authorization Cutover": no authorization-time self-healing — the explicit migration
    // step is what gives this legacy-role-seeded membership a resolvable role_id at all.
    await orgCtx.legacyMigration.migrateOrganization(organizationId);

    await obligations.insert({
      businessProfileId: organizationId,
      customerId: randomUUID(),
      invoiceReference: "INV-1",
      originalAmountMinorUnits: 10_000,
      agreedAmountMinorUnits: 10_000,
    });
  });

  function handler() {
    return withErrorHandling("test", createOrganizationBalancesGetHandler(authCtx.authService, orgCtx.permissions, obligations));
  }

  function request(orgId: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/balances?organizationId=${orgId}`, {
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("an active member (VIEWER included — not a sensitive resource) can list the organization's balances", async () => {
    const response = await handler()(request(organizationId, memberToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ invoiceReference: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.invoiceReference).toBe("INV-1");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(request(organizationId));
    expect(response.status).toBe(401);
  });

  it("denies a non-member with 403, never leaking the organization's balances", async () => {
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

  it("denies access to an organization the caller is not a member of, even if they are a member of a different one (cross-tenant)", async () => {
    const otherOrg = await orgCtx.businessProfiles.insert({
      ownerUserId: memberUserId,
      legalBusinessName: "Other Co",
      displayName: "Other Co",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    // memberUserId has no staff membership in otherOrg.
    const response = await handler()(request(otherOrg.id, memberToken));
    expect(response.status).toBe(403);
  });

  it("rejects an invalid organizationId with 400", async () => {
    const response = await handler()(request("not-a-uuid", memberToken));
    expect(response.status).toBe(400);
  });
});
