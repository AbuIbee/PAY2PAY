import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { ORGANIZATION_AGREEMENTS_FEATURE_KEY } from "./entitlementFeatureKeys";
import { createTestAgreementWorkspaceService } from "./testFakes";

function draftTerms(overrides: Record<string, unknown> = {}) {
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly" as const,
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays" as const,
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

describe("AgreementWorkspaceService", () => {
  let ctx: ReturnType<typeof createTestAgreementWorkspaceService>;
  let userId: string;
  let creditorProfileId: string;
  let debtorProfileId: string;
  let orgAId: string;
  let orgBId: string;

  function draftInput() {
    return {
      creditor: { kind: "personal" as const, id: creditorProfileId },
      debtor: { kind: "personal" as const, id: debtorProfileId },
      ...draftTerms(),
    };
  }

  async function seedEntitledPlan(organizationId: string, featureKey = ORGANIZATION_AGREEMENTS_FEATURE_KEY) {
    const plan = ctx.entitlementCtx.plans.seed({ kind: "business", code: `plan-${organizationId}`, name: "Growth" });
    await ctx.entitlementCtx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
    ctx.entitlementCtx.entitlements.seed({ pricingPlanId: plan.id, featureKey, enabled: true, limitValue: null });
    return plan;
  }

  beforeEach(async () => {
    ctx = createTestAgreementWorkspaceService();
    userId = randomUUID();
    creditorProfileId = randomUUID();
    debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, userId);

    const orgA = await ctx.orgAuthCtx.businessProfiles.insert({
      ownerUserId: randomUUID(),
      legalBusinessName: "Org A LLC",
      displayName: "Org A",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    });
    orgAId = orgA.id;
    const orgB = await ctx.orgAuthCtx.businessProfiles.insert({
      ownerUserId: randomUUID(),
      legalBusinessName: "Org B LLC",
      displayName: "Org B",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    });
    orgBId = orgB.id;
  });

  describe("personal workspace", () => {
    it("creates the agreement with organizationId NULL", async () => {
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "personal" },
        draftInput: draftInput(),
      });
      expect(result.agreement.organizationId).toBeNull();
    });

    it("requires no organization membership — succeeds with zero memberships/organizations relevant to this user at all", async () => {
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "personal" },
        draftInput: draftInput(),
      });
      expect(result.agreement.id).toBeTruthy();
    });

    it("requires no business entitlement — succeeds with zero pricing plans/subscriptions/entitlement rows seeded anywhere", async () => {
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "personal" },
        draftInput: draftInput(),
      });
      expect(result.agreement.organizationId).toBeNull();
    });

    it("a malicious organizationId smuggled inside draftInput cannot convert a personal agreement into an organization agreement", async () => {
      const pollutedDraftInput = { ...draftInput(), organizationId: orgAId } as unknown as ReturnType<typeof draftInput>;
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "personal" },
        draftInput: pollutedDraftInput,
      });
      expect(result.agreement.organizationId).toBeNull();
    });

    it("inactive subscription elsewhere does not affect personal agreement creation", async () => {
      const plan = await seedEntitledPlan(orgAId);
      const sub = await ctx.entitlementCtx.subscriptions.findActiveByProfile("business", orgAId);
      await ctx.entitlementCtx.subscriptions.cancel(sub!.id);
      void plan;

      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "personal" },
        draftInput: draftInput(),
      });
      expect(result.agreement.organizationId).toBeNull();
    });
  });

  describe("organization workspace", () => {
    it("an active, entitled OWNER can create an organization agreement, and the server assigns the correct organizationId", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      await seedEntitledPlan(orgAId);

      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "organization", organizationId: orgAId },
        draftInput: draftInput(),
      });
      expect(result.agreement.organizationId).toBe(orgAId);
    });

    it("FINANCE_ADMIN can create if entitled", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "FINANCE_ADMIN" });
      await seedEntitledPlan(orgAId);
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "organization", organizationId: orgAId },
        draftInput: draftInput(),
      });
      expect(result.agreement.organizationId).toBe(orgAId);
    });

    it("AR_MANAGER can create if entitled", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "AR_MANAGER" });
      await seedEntitledPlan(orgAId);
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "organization", organizationId: orgAId },
        draftInput: draftInput(),
      });
      expect(result.agreement.organizationId).toBe(orgAId);
    });

    it("AR_AGENT cannot create an organization agreement under the conservative Phase-8 policy, even when entitled", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "AR_AGENT" });
      await seedEntitledPlan(orgAId);
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("VIEWER cannot create an organization agreement", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "VIEWER" });
      await seedEntitledPlan(orgAId);
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a non-member cannot create an organization agreement", async () => {
      await seedEntitledPlan(orgAId);
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a removed member cannot create an organization agreement", async () => {
      const member = ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "FINANCE_ADMIN" });
      await ctx.orgAuthCtx.staffMembers.markRemoved(member.id, new Date());
      await seedEntitledPlan(orgAId);
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a pending invitation (never accepted into a real membership) grants no access to create an organization agreement", async () => {
      await seedEntitledPlan(orgAId);
      await ctx.orgAuthCtx.invitations.insert({
        businessProfileId: orgAId,
        email: "invitee@example.com",
        role: "FINANCE_ADMIN",
        customRoleId: null,
        invitedByUserId: randomUUID(),
        tokenHash: "hash",
        expiresAt: new Date(Date.now() + 60_000),
      });
      // The invited person has never accepted — they have no business_staff_member row at all.
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("an Org A member cannot create an agreement scoped to Org B", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      await seedEntitledPlan(orgBId);
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgBId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("the browser cannot substitute another organizationId by smuggling one inside draftInput — the server-resolved workspace id always wins", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      await seedEntitledPlan(orgAId);
      const pollutedDraftInput = { ...draftInput(), organizationId: orgBId } as unknown as ReturnType<typeof draftInput>;

      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "organization", organizationId: orgAId },
        draftInput: pollutedDraftInput,
      });
      expect(result.agreement.organizationId).toBe(orgAId);
      expect(result.agreement.organizationId).not.toBe(orgBId);
    });
  });

  describe("entitlement", () => {
    it("active membership + missing entitlement catalog entirely = denied", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "FINANCE_ADMIN" });
      // No plan/subscription/entitlement seeded at all for orgA.
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("OWNER + missing entitlement = denied — OWNER never bypasses the plan entitlement check", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      const plan = ctx.entitlementCtx.plans.seed({ kind: "business", code: "starter", name: "Starter" });
      await ctx.entitlementCtx.subscriptions.insert({ profileKind: "business", profileId: orgAId, pricingPlanId: plan.id });
      // Active subscription exists, but no organization_agreements entitlement row for this plan.
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("an inactive (canceled) subscription denies organization agreement creation even though the plan's catalog would otherwise allow it", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      await seedEntitledPlan(orgAId);
      const sub = await ctx.entitlementCtx.subscriptions.findActiveByProfile("business", orgAId);
      await ctx.entitlementCtx.subscriptions.cancel(sub!.id);

      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("mutation fail-closed — an explicit organization request never silently downgrades to personal", () => {
    it("an invalid (nonexistent) organization selector throws, and creates no agreement of any kind", async () => {
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: randomUUID() },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
      expect(await ctx.agreementCtx.agreements.listForProfile("personal", creditorProfileId)).toHaveLength(0);
    });

    it("a cross-tenant selector throws, and never falls back to creating a personal agreement", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      await seedEntitledPlan(orgBId);
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgBId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
      expect(await ctx.agreementCtx.agreements.listForProfile("personal", creditorProfileId)).toHaveLength(0);
    });

    it("a removed-membership selector throws, and never falls back to creating a personal agreement", async () => {
      const member = ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      await ctx.orgAuthCtx.staffMembers.markRemoved(member.id, new Date());
      await seedEntitledPlan(orgAId);
      await expect(
        ctx.agreementWorkspaceService.createDraftForWorkspace({
          userId,
          workspaceSelector: { kind: "organization", organizationId: orgAId },
          draftInput: draftInput(),
        }),
      ).rejects.toThrow(ForbiddenError);
      expect(await ctx.agreementCtx.agreements.listForProfile("personal", creditorProfileId)).toHaveLength(0);
    });
  });

  describe("persistence", () => {
    it("organization agreement is persisted with exactly the validated organizationId, retrievable via the tenant-scoped repository method", async () => {
      ctx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId, role: "OWNER" });
      await seedEntitledPlan(orgAId);
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "organization", organizationId: orgAId },
        draftInput: draftInput(),
      });

      expect(await ctx.agreementCtx.agreements.findOrganizationAgreement(orgAId, result.agreement.id)).not.toBeNull();
      expect(await ctx.agreementCtx.agreements.findOrganizationAgreement(orgBId, result.agreement.id)).toBeNull();
    });

    it("personal agreement is persisted with NULL organizationId and is absent from any organization's tenant-scoped lookup", async () => {
      const result = await ctx.agreementWorkspaceService.createDraftForWorkspace({
        userId,
        workspaceSelector: { kind: "personal" },
        draftInput: draftInput(),
      });

      expect(result.agreement.organizationId).toBeNull();
      expect(await ctx.agreementCtx.agreements.findOrganizationAgreement(orgAId, result.agreement.id)).toBeNull();
    });
  });
});
