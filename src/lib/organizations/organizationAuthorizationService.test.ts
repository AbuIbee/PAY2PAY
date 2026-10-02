import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestOrganizationAuthorizationService } from "./testFakes";

describe("OrganizationAuthorizationService", () => {
  let ctx: ReturnType<typeof createTestOrganizationAuthorizationService>;
  let orgAId: string;
  let orgBId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    ctx = createTestOrganizationAuthorizationService();
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

  it("resolveOrganizationMembership: returns null for a non-member", async () => {
    expect(await ctx.orgAuth.resolveOrganizationMembership(randomUUID(), orgAId)).toBeNull();
  });

  it("cross-tenant: a member of Org A has no membership in Org B — a client-supplied organizationId cannot cross tenants", async () => {
    expect(await ctx.orgAuth.resolveOrganizationMembership(ownerUserId, orgBId)).toBeNull();
  });

  it("resolveOrganizationMembership: returns null for a nonexistent organization (same shape as a non-member, not a distinguishing error)", async () => {
    expect(await ctx.orgAuth.resolveOrganizationMembership(ownerUserId, randomUUID())).toBeNull();
  });

  it("resolveOrganizationMembership: returns null once the organization itself is disabled, even for its owner", async () => {
    await ctx.businessProfiles.updateStatus(orgAId, "disabled");
    expect(await ctx.orgAuth.resolveOrganizationMembership(ownerUserId, orgAId)).toBeNull();
  });

  it("removed member immediately loses access", async () => {
    const memberUserId = randomUUID();
    const member = ctx.staffMembers.seed({ businessProfileId: orgAId, userId: memberUserId, role: "FINANCE_ADMIN" });
    expect(await ctx.orgAuth.resolveOrganizationMembership(memberUserId, orgAId)).not.toBeNull();

    await ctx.staffMembers.markRemoved(member.id, new Date());
    expect(await ctx.orgAuth.resolveOrganizationMembership(memberUserId, orgAId)).toBeNull();
  });

  describe("VIEWER", () => {
    let viewerUserId: string;
    beforeEach(() => {
      viewerUserId = randomUUID();
      ctx.staffMembers.seed({ businessProfileId: orgAId, userId: viewerUserId, role: "VIEWER" });
    });

    it("can enter/read an allowed ordinary organization resource via plain active membership", async () => {
      for (const resourceType of ["dashboard", "outstanding_balances", "customers", "agreements", "payments", "employees", "reports", "documents"] as const) {
        expect(await ctx.orgAuth.canReadOrganizationResource(viewerUserId, orgAId, resourceType)).toBe(true);
      }
    });

    it("cannot mutate", async () => {
      for (const capability of ["manage_customers", "manage_balances", "create_agreement", "manage_staff"] as const) {
        expect(await ctx.orgAuth.can(viewerUserId, orgAId, capability)).toBe(false);
      }
    });

    it("cannot access sensitive capability-gated reads", async () => {
      for (const resourceType of ["audit_history", "reconciliation", "integrations", "subscription", "organization_settings"] as const) {
        expect(await ctx.orgAuth.canReadOrganizationResource(viewerUserId, orgAId, resourceType)).toBe(false);
      }
    });
  });

  describe("AR_AGENT", () => {
    let arAgentUserId: string;
    beforeEach(() => {
      arAgentUserId = randomUUID();
      ctx.staffMembers.seed({ businessProfileId: orgAId, userId: arAgentUserId, role: "AR_AGENT" });
    });

    it("cannot modify organization settings", async () => {
      expect(await ctx.orgAuth.can(arAgentUserId, orgAId, "manage_organization_settings")).toBe(false);
    });

    it("cannot manage subscription", async () => {
      expect(await ctx.orgAuth.can(arAgentUserId, orgAId, "manage_subscription")).toBe(false);
    });

    it("cannot access sensitive reads it holds no capability for", async () => {
      expect(await ctx.orgAuth.canReadOrganizationResource(arAgentUserId, orgAId, "audit_history")).toBe(false);
      expect(await ctx.orgAuth.canReadOrganizationResource(arAgentUserId, orgAId, "integrations")).toBe(false);
    });

    it("can still read ordinary resources and perform its own day-to-day capability", async () => {
      expect(await ctx.orgAuth.canReadOrganizationResource(arAgentUserId, orgAId, "customers")).toBe(true);
      expect(await ctx.orgAuth.can(arAgentUserId, orgAId, "manage_customers")).toBe(true);
    });
  });

  it("OWNER holds every capability and every sensitive read", async () => {
    expect(await ctx.orgAuth.can(ownerUserId, orgAId, "manage_staff")).toBe(true);
    expect(await ctx.orgAuth.canReadOrganizationResource(ownerUserId, orgAId, "audit_history")).toBe(true);
    expect(await ctx.orgAuth.canReadOrganizationResource(ownerUserId, orgAId, "subscription")).toBe(true);
  });

  it("a non-member (authenticated elsewhere, but no membership here) cannot read even an ordinary resource", async () => {
    const strangerUserId = randomUUID();
    expect(await ctx.orgAuth.canReadOrganizationResource(strangerUserId, orgAId, "customers")).toBe(false);
    expect(await ctx.orgAuth.can(strangerUserId, orgAId, "manage_customers")).toBe(false);
  });

  it("a pending (never-accepted) invitation grants no organization access at all", async () => {
    const invitedUserId = randomUUID();
    ctx.userEmails.set(invitedUserId, "invited-not-yet-accepted@example.com");
    await ctx.invitations.insert({
      businessProfileId: orgAId,
      email: "invited-not-yet-accepted@example.com",
      role: "FINANCE_ADMIN",
      customRoleId: null,
      invitedByUserId: ownerUserId,
      tokenHash: "unused-hash",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await ctx.orgAuth.resolveOrganizationMembership(invitedUserId, orgAId)).toBeNull();
    expect(await ctx.orgAuth.can(invitedUserId, orgAId, "manage_customers")).toBe(false);
    expect(await ctx.orgAuth.canReadOrganizationResource(invitedUserId, orgAId, "customers")).toBe(false);
  });

  it("an inactive/missing organization subscription never blocks OWNER's manage_subscription capability — the recovery path is membership-gated, never entitlement-gated", async () => {
    // No subscription of any kind exists for orgAId anywhere in this test — proving the capability
    // check itself never reaches EntitlementService at all, regardless of subscription state.
    expect(await ctx.orgAuth.can(ownerUserId, orgAId, "manage_subscription")).toBe(true);
    expect(await ctx.orgAuth.canReadOrganizationResource(ownerUserId, orgAId, "subscription")).toBe(true);
  });
});
