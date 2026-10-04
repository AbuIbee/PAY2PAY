import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import {
  AgreementProgressService,
  type AgreementBalanceReader,
  type AgreementCancellationInfo,
  type AgreementCancellationReader,
  type AgreementInstallmentStatusReader,
  type AgreementMandateReader,
  type AgreementPaymentAttemptsReader,
  type RelationshipPaymentMethodReader,
} from "@/lib/agreements/agreementProgressService";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createOrganizationAgreementsGetHandler } from "./route";

class FakePaymentMethods implements RelationshipPaymentMethodReader {
  async getRelationshipAccounts() {
    return [];
  }
}
class FakeCancellation implements AgreementCancellationReader {
  async getCancellationInfo(): Promise<AgreementCancellationInfo | null> {
    return null;
  }
}
class FakeMandates implements AgreementMandateReader {
  async isActiveForAgreement() {
    return false;
  }
}
class FakeInstallments implements AgreementInstallmentStatusReader {
  async listForAgreement() {
    return [];
  }
}
class FakePaymentAttempts implements AgreementPaymentAttemptsReader {
  async listByAgreementId() {
    return [];
  }
}
class FakeBalance implements AgreementBalanceReader {
  async getAgreementBalance(): Promise<never> {
    throw new Error("no balance in this test");
  }
}

describe("GET /api/organizations/agreements", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let progressService: AgreementProgressService;
  let organizationId: string;
  let ownerUserId: string;
  let ownerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    agreementCtx = createTestAgreementService();
    progressService = new AgreementProgressService({
      agreementService: agreementCtx.agreementService,
      relationshipPaymentMethods: new FakePaymentMethods(),
      cancellation: new FakeCancellation(),
      mandates: new FakeMandates(),
      installments: new FakeInstallments(),
      paymentAttempts: new FakePaymentAttempts(),
      balance: new FakeBalance(),
    });

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
    ownerUserId = owner.user.id;
    ownerToken = owner.token;

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

    // `agreementCtx` is a deliberately independent AgreementService instance (its own profile-owner
    // store and its own staff store), exactly mirroring production where `AgreementService` and
    // `OrganizationPermissionService` are separate services reading the SAME underlying Postgres
    // tables. Here, only the owner-identity shortcut inside `AgreementService.authorizeParty` is
    // wired across the two fakes — proving the organization-level `agreements.view` gate and the
    // unchanged Phase 9 party-level gate are two genuinely independent checks (Step 9), not just the
    // same check read twice.
    agreementCtx.profileOwners.set("business", organizationId, ownerUserId);
  });

  function handler() {
    return withErrorHandling(
      "test",
      createOrganizationAgreementsGetHandler(authCtx.authService, orgCtx.permissions, agreementCtx.agreementService, progressService),
    );
  }

  function request(orgId: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/agreements?organizationId=${orgId}`, {
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("the OWNER can list the organization's agreements (empty list)", async () => {
    const response = await handler()(request(organizationId, ownerToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agreements: unknown[]; limit: number; offset: number; hasMore: boolean };
    expect(body.agreements).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it("an active organization member is denied by the unchanged Phase 9 party-level check even though they hold agreements.view — the two gates are independent", async () => {
    const member = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "member@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    // Active in the organization fakes (grants agreements.view via the ambient-read backfill), but
    // never seeded into `agreementCtx`'s own staff store — so Phase 9's `requireActiveStaff` inside
    // `AgreementService.listAgreements` independently denies them.
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: member.user.id, role: "VIEWER", customRoleId: null, isAuthorizedRepresentative: false });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);

    const response = await handler()(request(organizationId, member.token));
    expect(response.status).toBe(403);
  });

  it("denies a non-member of the organization with 403", async () => {
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

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(request(organizationId));
    expect(response.status).toBe(401);
  });

  it("rejects a missing organizationId with 400", async () => {
    const response = await handler()(new NextRequest("http://localhost/api/organizations/agreements", { headers: { cookie: `p2p_session=${ownerToken}` } }));
    expect(response.status).toBe(400);
  });
});
