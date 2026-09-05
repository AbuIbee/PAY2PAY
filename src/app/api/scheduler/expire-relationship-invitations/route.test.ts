import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { createTestRelationshipServices } from "@/lib/relationships/testFakes";
import { createExpireRelationshipInvitationsHandler, GET, POST } from "./route";

const TEST_CRON_SECRET = "test-cron-secret-0123456789abcdef";

function requestWithAuth(method: "GET" | "POST", authHeader?: string) {
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return new NextRequest("http://localhost/api/scheduler/expire-relationship-invitations", { method, headers });
}

function postWithAuth(authHeader?: string) {
  return requestWithAuth("POST", authHeader);
}

describe("POST /api/scheduler/expire-relationship-invitations", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;

  beforeAll(() => {
    // getServerEnv() memoizes on first call — set this once, before any handler invocation, matching
    // every other scheduler route test's constraint in this codebase (none vary CRON_SECRET at runtime).
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  beforeEach(() => {
    ctx = createTestRelationshipServices();
  });

  function handler() {
    return withErrorHandling("scheduler_expire_relationship_invitations", createExpireRelationshipInvitationsHandler(ctx.relationshipInvitationService));
  }

  async function createDueInvitation(inviteeEmail = "invitee@example.com") {
    const creditorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    const { relationship, invitation, rawToken } = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: creditorUserId,
      actingParty: { kind: "personal", id: creditorProfileId },
      inviteeEmail,
      inviteeRole: "debtor",
    });
    return { relationship, invitation, rawToken, creditorUserId, creditorProfileId };
  }

  it("rejects a request with no authorization header (403)", async () => {
    const response = await handler()(postWithAuth());
    expect(response.status).toBe(403);
  });

  it("rejects a request with an invalid/wrong bearer token (403)", async () => {
    const response = await handler()(postWithAuth("Bearer not-the-real-secret"));
    expect(response.status).toBe(403);
  });

  it("accepts a request with the correct bearer token (200)", async () => {
    const response = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.expired).toBe(0);
  });

  it("transitions a due invitation to expired, and leaves a not-yet-due invitation unchanged", async () => {
    const due = await createDueInvitation("due@example.com");
    const stored = ctx.invitations.byId.get(due.invitation.id);
    if (stored) stored.expiresAt = new Date(Date.now() - 1000);

    const notDue = await createDueInvitation("not-due@example.com");
    // Default expiresAt is 7 days out — left untouched, still in the future.

    const response = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.expired).toBe(1);

    const dueUpdated = await ctx.invitations.findById(due.invitation.id);
    expect(dueUpdated?.status).toBe("expired");

    const notDueUpdated = await ctx.invitations.findById(notDue.invitation.id);
    expect(notDueUpdated?.status).toBe("sent");
  });

  it("does not mutate an accepted invitation even if its expiresAt has technically passed", async () => {
    const debtorUserId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    ctx.users.set("accepted@example.com", debtorUserId);
    const created = await createDueInvitation("accepted@example.com");

    await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: created.invitation.id,
      actingUserId: debtorUserId,
      actingParty: { kind: "personal", id: debtorProfileId },
    });
    const stored = ctx.invitations.byId.get(created.invitation.id);
    if (stored) stored.expiresAt = new Date(Date.now() - 1000);

    const response = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const body = await response.json();
    expect(body.expired).toBe(0);

    const updated = await ctx.invitations.findById(created.invitation.id);
    expect(updated?.status).toBe("accepted");
  });

  it("does not mutate a declined invitation, and does not mutate a cancelled invitation, even if expiresAt has technically passed", async () => {
    const declined = await createDueInvitation("declined@example.com");
    await ctx.relationshipInvitationService.declineInvitation({ invitationId: declined.invitation.id, actingUserId: randomUUID(), rawToken: declined.rawToken });
    const declinedStored = ctx.invitations.byId.get(declined.invitation.id);
    if (declinedStored) declinedStored.expiresAt = new Date(Date.now() - 1000);

    const cancelled = await createDueInvitation("cancelled@example.com");
    await ctx.relationshipInvitationService.cancelInvitation({ invitationId: cancelled.invitation.id, actingUserId: cancelled.creditorUserId });
    const cancelledStored = ctx.invitations.byId.get(cancelled.invitation.id);
    if (cancelledStored) cancelledStored.expiresAt = new Date(Date.now() - 1000);

    const response = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const body = await response.json();
    expect(body.expired).toBe(0);

    expect((await ctx.invitations.findById(declined.invitation.id))?.status).toBe("declined");
    expect((await ctx.invitations.findById(cancelled.invitation.id))?.status).toBe("cancelled");
  });

  it("is idempotent across repeated executions: a second call expires nothing further and reports expired: 0", async () => {
    const due = await createDueInvitation("repeat@example.com");
    const stored = ctx.invitations.byId.get(due.invitation.id);
    if (stored) stored.expiresAt = new Date(Date.now() - 1000);

    const first = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const firstBody = await first.json();
    expect(firstBody.expired).toBe(1);

    const second = await handler()(postWithAuth(`Bearer ${TEST_CRON_SECRET}`));
    const secondBody = await second.json();
    expect(secondBody.expired).toBe(0);

    // Relationship state consequence (cancellation) is also not duplicated/erroring on replay.
    const relationship = await ctx.relationships.findById(due.relationship.id);
    expect(relationship?.status).toBe("cancelled");
  });

  describe("Vercel Cron GET support (remediation 01)", () => {
    it("exports GET as the exact same handler reference as POST — no duplicated scheduler logic", () => {
      expect(GET).toBe(POST);
    });

    it("rejects a GET request with no authorization header (403) and does not expire anything", async () => {
      const due = await createDueInvitation("get-no-auth@example.com");
      const stored = ctx.invitations.byId.get(due.invitation.id);
      if (stored) stored.expiresAt = new Date(Date.now() - 1000);

      const response = await handler()(requestWithAuth("GET"));
      expect(response.status).toBe(403);
      const updated = await ctx.invitations.findById(due.invitation.id);
      expect(updated?.status).toBe("sent");
    });

    it("rejects a GET request with an invalid bearer token (403) and does not expire anything", async () => {
      const due = await createDueInvitation("get-bad-auth@example.com");
      const stored = ctx.invitations.byId.get(due.invitation.id);
      if (stored) stored.expiresAt = new Date(Date.now() - 1000);

      const response = await handler()(requestWithAuth("GET", "Bearer not-the-real-secret"));
      expect(response.status).toBe(403);
      const updated = await ctx.invitations.findById(due.invitation.id);
      expect(updated?.status).toBe("sent");
    });

    it("accepts an authenticated GET request (200) and expires due invitations, identically to POST", async () => {
      const due = await createDueInvitation("get-due@example.com");
      const stored = ctx.invitations.byId.get(due.invitation.id);
      if (stored) stored.expiresAt = new Date(Date.now() - 1000);

      const response = await handler()(requestWithAuth("GET", `Bearer ${TEST_CRON_SECRET}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.expired).toBe(1);

      const updated = await ctx.invitations.findById(due.invitation.id);
      expect(updated?.status).toBe("expired");
    });
  });
});
