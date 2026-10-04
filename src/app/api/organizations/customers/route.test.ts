import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import type { ProfileDisplayReader } from "@/lib/documents/profileDisplayReader";
import { InMemoryBusinessCustomerRepository, createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createOrganizationCustomersGetHandler } from "./route";

class FakeProfileDisplayReader implements ProfileDisplayReader {
  async getDisplayName(): Promise<string> {
    return "Jane Counterparty";
  }
}

describe("GET /api/organizations/customers", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let customers: InMemoryBusinessCustomerRepository;
  let organizationId: string;
  let memberUserId: string;
  let memberToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    customers = new InMemoryBusinessCustomerRepository();

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
    await orgCtx.legacyMigration.migrateOrganization(organizationId);

    await customers.insert({ businessProfileId: organizationId, counterpartyProfileKind: "personal", counterpartyProfileId: "11111111-1111-1111-1111-111111111111" });
  });

  function handler() {
    return withErrorHandling("test", createOrganizationCustomersGetHandler(authCtx.authService, orgCtx.permissions, customers, new FakeProfileDisplayReader()));
  }

  function request(orgId: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/customers?organizationId=${orgId}`, {
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("an active member (VIEWER included) can list the organization's customers", async () => {
    const response = await handler()(request(organizationId, memberToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ displayName: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.displayName).toBe("Jane Counterparty");
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
