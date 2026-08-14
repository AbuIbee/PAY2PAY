import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestRelationshipServices } from "@/lib/relationships/testFakes";
import { createRelationshipInvitationsListHandler } from "./route";

const URL = "http://localhost/api/relationships/invitations";

function getWithCookie(relationshipId: string, token?: string) {
  return new NextRequest(`${URL}?relationshipId=${relationshipId}`, {
    headers: token ? { cookie: `p2p_session=${token}` } : {},
  });
}

describe("GET /api/relationships/invitations", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let relCtx: ReturnType<typeof createTestRelationshipServices>;

  beforeEach(() => {
    authCtx = createTestAuthService();
    relCtx = createTestRelationshipServices();
  });

  function handlerFor() {
    return withErrorHandling(
      "relationship_invitations_list",
      createRelationshipInvitationsListHandler(authCtx.authService, relCtx.relationshipService, relCtx.relationshipInvitationService),
    );
  }

  async function seedRelationshipWithInvitation() {
    const signup = await authCtx.authService.signup({
      email: `inviter-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const profileId = randomUUID();
    relCtx.profileOwners.set("personal", profileId, signup.user.id);
    const { relationship, invitation } = await relCtx.relationshipInvitationService.createInvitation({
      actingUserId: signup.user.id,
      actingParty: { kind: "personal", id: profileId },
      inviteeEmail: "someone-else@example.com",
      inviteeRole: "debtor",
    });
    return { token: signup.token, relationship, invitation };
  }

  it("lists invitations for a relationship the caller participates in", async () => {
    const { token, relationship, invitation } = await seedRelationshipWithInvitation();
    const response = await handlerFor()(getWithCookie(relationship.id, token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { invitations: Array<{ id: string }> };
    expect(body.invitations.map((i) => i.id)).toContain(invitation.id);
  });

  it("rejects a caller who is not a participant in the relationship with 403", async () => {
    const { relationship } = await seedRelationshipWithInvitation();
    const outsider = await authCtx.authService.signup({
      email: `outsider-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handlerFor()(getWithCookie(relationship.id, outsider.token));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { relationship } = await seedRelationshipWithInvitation();
    const response = await handlerFor()(getWithCookie(relationship.id));
    expect(response.status).toBe(401);
  });

  it("returns 400 when relationshipId is missing", async () => {
    const { token } = await seedRelationshipWithInvitation();
    const response = await handlerFor()(new NextRequest(URL, { headers: { cookie: `p2p_session=${token}` } }));
    expect(response.status).toBe(400);
  });
});
