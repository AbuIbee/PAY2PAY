import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { InMemoryEmailSender } from "@/lib/auth/testFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createTestOrganizationAuditedMutations } from "@/lib/organizations/organizationAuditedMutationsTestFakes";
import { createInvitationsGetHandler, createInvitationsPostHandler } from "./route";

describe("/api/organizations/invitations", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let mutationsCtx: ReturnType<typeof createTestOrganizationAuditedMutations>;
  let emailSender: InMemoryEmailSender;
  let organizationId: string;
  let ownerToken: string;
  let managerRoleId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    mutationsCtx = createTestOrganizationAuditedMutations(orgCtx.roles, orgCtx.staffMembers, orgCtx.invitations);
    emailSender = new InMemoryEmailSender();

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
    const seeded = await orgCtx.roleService.seedDefaultRolesForNewOrganization(organizationId);
    managerRoleId = seeded.managerRoleId;
    orgCtx.staffMembers.seed({ businessProfileId: organizationId, userId: owner.user.id, role: "OWNER", roleId: seeded.ownerRoleId });
  });

  function getHandler() {
    return withErrorHandling("test", createInvitationsGetHandler(authCtx.authService, orgCtx.permissions, orgCtx.invitations));
  }
  function postHandler() {
    return withErrorHandling("test", createInvitationsPostHandler(authCtx.authService, orgCtx.permissions, mutationsCtx.mutations, orgCtx.roles, emailSender, "https://app.example.com"));
  }

  it("an OWNER (members.invite) can invite a new team member to an organization-owned role", async () => {
    const response = await postHandler()(
      new NextRequest("http://localhost/api/organizations/invitations", {
        method: "POST",
        body: JSON.stringify({ organizationId, email: "newhire@example.com", roleId: managerRoleId }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${ownerToken}` },
      }),
    );
    expect(response.status).toBe(201);
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]!.to).toBe("newhire@example.com");
  });

  it("rejects a roleId belonging to a DIFFERENT organization", async () => {
    const otherOrg = await orgCtx.businessProfiles.insert({ ownerUserId: "other-owner", legalBusinessName: "Other Co", displayName: "Other Co", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    const otherRole = await orgCtx.roleService.createRole({ organizationId: otherOrg.id, displayName: "Other", description: null, permissions: [] });
    const response = await postHandler()(
      new NextRequest("http://localhost/api/organizations/invitations", {
        method: "POST",
        body: JSON.stringify({ organizationId, email: "newhire@example.com", roleId: otherRole.id }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${ownerToken}` },
      }),
    );
    expect(response.status).toBe(400);
    expect(emailSender.sent).toHaveLength(0);
  });

  it("a VIEWER (no members.invite) is denied inviting", async () => {
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
    orgCtx.staffMembers.seed({ businessProfileId: organizationId, userId: viewer.user.id, role: "VIEWER" });
    const response = await postHandler()(
      new NextRequest("http://localhost/api/organizations/invitations", {
        method: "POST",
        body: JSON.stringify({ organizationId, email: "newhire@example.com", roleId: managerRoleId }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${viewer.token}` },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("GET lists pending invitations for an authorized caller (members.view), scoped to this organization", async () => {
    await postHandler()(
      new NextRequest("http://localhost/api/organizations/invitations", {
        method: "POST",
        body: JSON.stringify({ organizationId, email: "newhire@example.com", roleId: managerRoleId }),
        headers: { "content-type": "application/json", cookie: `p2p_session=${ownerToken}` },
      }),
    );
    const response = await getHandler()(new NextRequest(`http://localhost/api/organizations/invitations?organizationId=${organizationId}`, { headers: { cookie: `p2p_session=${ownerToken}` } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ email: string; roleId: string | null }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.email).toBe("newhire@example.com");
    expect(body.items[0]!.roleId).toBe(managerRoleId);
  });
});
