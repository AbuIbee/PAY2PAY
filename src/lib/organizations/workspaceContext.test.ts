import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestWorkspaceContextService } from "./testFakes";

describe("WorkspaceContextService", () => {
  let ctx: ReturnType<typeof createTestWorkspaceContextService>;
  let orgAId: string;
  let orgBId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    ctx = createTestWorkspaceContextService();
    ownerUserId = randomUUID();
    const orgA = await ctx.businessProfiles.insert({
      ownerUserId,
      legalBusinessName: "Org A LLC",
      displayName: "Org A",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    });
    orgAId = orgA.id;
    const orgB = await ctx.businessProfiles.insert({
      ownerUserId: randomUUID(),
      legalBusinessName: "Org B LLC",
      displayName: "Org B",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    });
    orgBId = orgB.id;
    ctx.staffMembers.seed({ businessProfileId: orgAId, userId: ownerUserId, role: "OWNER" });
  });

  it("personal selector always resolves to the personal context — the authenticated identity never changes", async () => {
    expect(await ctx.workspaceContext.resolveWorkspaceContext(ownerUserId, { kind: "personal" })).toEqual({ kind: "personal" });
  });

  it("organization selector with a valid active membership resolves with the caller's real role", async () => {
    const result = await ctx.workspaceContext.resolveWorkspaceContext(ownerUserId, { kind: "organization", organizationId: orgAId });
    expect(result).toEqual({ kind: "organization", organizationId: orgAId, membershipRole: "OWNER" });
  });

  it("organization context is rejected (falls back to personal) when the caller has no membership at all", async () => {
    const strangerUserId = randomUUID();
    const result = await ctx.workspaceContext.resolveWorkspaceContext(strangerUserId, { kind: "organization", organizationId: orgAId });
    expect(result).toEqual({ kind: "personal" });
  });

  it("organization context is rejected (falls back to personal) once the membership has been removed", async () => {
    const memberUserId = randomUUID();
    const member = ctx.staffMembers.seed({ businessProfileId: orgAId, userId: memberUserId, role: "AR_MANAGER" });
    await ctx.staffMembers.markRemoved(member.id, new Date());

    const result = await ctx.workspaceContext.resolveWorkspaceContext(memberUserId, { kind: "organization", organizationId: orgAId });
    expect(result).toEqual({ kind: "personal" });
  });

  it("a member of Org A requesting Org B falls back to personal — client-supplied organizationId cannot cross tenants into a validated context", async () => {
    const result = await ctx.workspaceContext.resolveWorkspaceContext(ownerUserId, { kind: "organization", organizationId: orgBId });
    expect(result).toEqual({ kind: "personal" });
  });

  it("an unauthenticated/nonexistent-org selector also falls back to personal, same shape as a non-member", async () => {
    const result = await ctx.workspaceContext.resolveWorkspaceContext(ownerUserId, { kind: "organization", organizationId: randomUUID() });
    expect(result).toEqual({ kind: "personal" });
  });

  it("resolving the personal workspace never depends on, or is blocked by, any organization's subscription state — no entitlement lookup is even reachable from this selector", async () => {
    // orgAId has no subscription at all in this test; the personal selector still resolves cleanly,
    // and WorkspaceContextService has no dependency on EntitlementService to begin with.
    const result = await ctx.workspaceContext.resolveWorkspaceContext(ownerUserId, { kind: "personal" });
    expect(result).toEqual({ kind: "personal" });
  });

  describe("listWorkspacesForUser (Section 7/8: workspace selector listing)", () => {
    it("a user with one organization membership sees exactly that one organization", async () => {
      const list = await ctx.workspaceContext.listWorkspacesForUser(ownerUserId);
      expect(list).toEqual([{ organizationId: orgAId, displayName: "Org A", membershipRole: "OWNER" }]);
    });

    it("a user with memberships in multiple organizations sees all of them, and never another user's organization", async () => {
      ctx.staffMembers.seed({ businessProfileId: orgBId, userId: ownerUserId, role: "VIEWER" });
      const list = await ctx.workspaceContext.listWorkspacesForUser(ownerUserId);
      expect(list.map((w) => w.organizationId).sort()).toEqual([orgAId, orgBId].sort());
    });

    it("a removed membership never appears in the listing", async () => {
      const memberUserId = randomUUID();
      const member = ctx.staffMembers.seed({ businessProfileId: orgAId, userId: memberUserId, role: "AR_MANAGER" });
      await ctx.staffMembers.markRemoved(member.id, new Date());
      const list = await ctx.workspaceContext.listWorkspacesForUser(memberUserId);
      expect(list).toEqual([]);
    });

    it("a user with no organization memberships sees an empty list (Personal-only)", async () => {
      const list = await ctx.workspaceContext.listWorkspacesForUser(randomUUID());
      expect(list).toEqual([]);
    });
  });
});
