import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { InMemoryStaffInvitationRepository } from "@/lib/staff/testFakes";
import { createInvitationsRevokeHandler } from "./route";

describe("POST /api/organizations/invitations/revoke", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let invitations: InMemoryStaffInvitationRepository;
  let organizationId: string;
  let ownerToken: string;
  let invitationId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    invitations = new InMemoryStaffInvitationRepository();

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
    orgCtx.staffMembers.seed({ businessProfileId: organizationId, userId: owner.user.id, role: "OWNER" });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);

    const invitation = await invitations.insert({
      businessProfileId: organizationId,
      email: "newhire@example.com",
      role: "VIEWER",
      customRoleId: null,
      invitedByUserId: owner.user.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    invitationId = invitation.id;
  });

  function handler() {
    return withErrorHandling("test", createInvitationsRevokeHandler(authCtx.authService, orgCtx.permissions, invitations));
  }

  it("an OWNER can revoke a pending invitation", async () => {
    const response = await handler()(
      new NextRequest("http://localhost/api/organizations/invitations/revoke", {
        method: "POST",
        body: JSON.stringify({ organizationId, invitationId }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${ownerToken}` },
      }),
    );
    expect(response.status).toBe(200);
    const revoked = await invitations.findByTokenHash("hash");
    expect(revoked!.status).toBe("revoked");
  });

  it("rejects an invitation belonging to a different organization", async () => {
    const otherOrg = await orgCtx.businessProfiles.insert({ ownerUserId: "other-owner", legalBusinessName: "Other Co", displayName: "Other Co", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    const otherInvitation = await invitations.insert({
      businessProfileId: otherOrg.id,
      email: "other@example.com",
      role: "VIEWER",
      customRoleId: null,
      invitedByUserId: "other-owner",
      tokenHash: "other-hash",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    const response = await handler()(
      new NextRequest("http://localhost/api/organizations/invitations/revoke", {
        method: "POST",
        body: JSON.stringify({ organizationId, invitationId: otherInvitation.id }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${ownerToken}` },
      }),
    );
    expect(response.status).toBe(400);
  });
});
