import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementWorkspaceService } from "@/lib/organizations/testFakes";
import { ORGANIZATION_AGREEMENTS_FEATURE_KEY } from "@/lib/organizations/entitlementFeatureKeys";
import { createAgreementCreateHandler } from "./route";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 9 (2026-10-02): the
 * real HTTP request path for the only production entry point wired through
 * AgreementWorkspaceService so far. Every test here goes through the actual `createAgreementCreateHandler`
 * function, the actual zod `createAgreementSchema`, and the actual `AgreementWorkspaceService` —
 * never a hand-rolled substitute — proving the route itself implements no authorization logic of its
 * own (it has none to bypass).
 */
function postWithCookie(body: unknown, token: string) {
  return new NextRequest("http://localhost/api/agreements", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `p2p_session=${token}` },
  });
}

describe("POST /api/agreements — AgreementWorkspaceService enforcement", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let wsCtx: ReturnType<typeof createTestAgreementWorkspaceService>;
  let creditorProfileId: string;
  let debtorProfileId: string;
  let orgAId: string;
  let orgBId: string;

  function handlerFor() {
    return withErrorHandling("agreement_create", createAgreementCreateHandler(authCtx.authService, wsCtx.agreementWorkspaceService));
  }

  async function signupUser(emailPrefix: string) {
    const user = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `${emailPrefix}-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    return { token: user.token, userId: user.user.id };
  }

  function draftBody(overrides: Record<string, unknown> = {}) {
    return {
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      category: "personal_loan",
      description: "Route-level test agreement",
      originalAmountMinorUnits: 50_000,
      previousPaymentsMinorUnits: 0,
      firstPaymentMinorUnits: 10_000,
      installmentAmountMinorUnits: 10_000,
      frequency: "monthly",
      firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      feeAllocation: "debtor_pays",
      earlyPayoffTerms: "No penalty.",
      hardshipRules: "Hardship relief available.",
      partialPaymentRules: "Creditor approval required.",
      settlementRules: "Either party may propose.",
      disputeProcedure: "Per platform policy.",
      ...overrides,
    };
  }

  async function seedEntitledPlan(organizationId: string, featureKey = ORGANIZATION_AGREEMENTS_FEATURE_KEY) {
    const plan = wsCtx.entitlementCtx.plans.seed({ kind: "business", code: `plan-${organizationId}`, name: "Growth" });
    await wsCtx.entitlementCtx.subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
    wsCtx.entitlementCtx.entitlements.seed({ pricingPlanId: plan.id, featureKey, enabled: true, limitValue: null });
    // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-5: EntitlementService now also
    // requires onboarding_step = "billing_setup_complete" (provider-confirmed billing).
    await wsCtx.entitlementCtx.businessProfiles.setOnboardingStep(organizationId, "billing_setup_complete");
  }

  async function seedOrg() {
    const org = await wsCtx.orgAuthCtx.businessProfiles.insert({
      ownerUserId: randomUUID(),
      legalBusinessName: `Route Test LLC ${randomUUID()}`,
      displayName: "Route Test",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    });
    return org.id;
  }

  function countAllAgreements(): number {
    return wsCtx.agreementCtx.agreements.byId.size;
  }

  beforeEach(async () => {
    authCtx = createTestAuthService();
    wsCtx = createTestAgreementWorkspaceService();
    const creditorUser = await signupUser("creditor");
    creditorProfileId = randomUUID();
    wsCtx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUser.userId);
    debtorProfileId = randomUUID();
    orgAId = await seedOrg();
    orgBId = await seedOrg();
    // Stash the creditor's own identity on the ctx object for reuse by tests (not a real field —
    // just convenient object attachment within this file's own scope).
    (wsCtx as unknown as { __creditorUser: { token: string; userId: string } }).__creditorUser = creditorUser;
  });

  function creditor() {
    return (wsCtx as unknown as { __creditorUser: { token: string; userId: string } }).__creditorUser;
  }

  describe("personal", () => {
    it("an authenticated user creates a personal agreement with organization_id NULL when workspace is omitted", async () => {
      const response = await handlerFor()(postWithCookie(draftBody(), creditor().token));
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string };
      expect(wsCtx.agreementCtx.agreements.byId.get(body.id)?.organizationId).toBeNull();
    });

    it("belonging to an organization does not change personal tenancy when the request explicitly asks for personal", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      await seedEntitledPlan(orgAId);

      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "personal" } }), creditor().token));
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string };
      expect(wsCtx.agreementCtx.agreements.byId.get(body.id)?.organizationId).toBeNull();
    });

    it("a missing/inactive business subscription anywhere never blocks personal agreement creation", async () => {
      const plan = wsCtx.entitlementCtx.plans.seed({ kind: "business", code: "starter", name: "Starter" });
      const sub = await wsCtx.entitlementCtx.subscriptions.insert({ profileKind: "business", profileId: orgAId, pricingPlanId: plan.id });
      await wsCtx.entitlementCtx.subscriptions.cancel(sub.id);

      const response = await handlerFor()(postWithCookie(draftBody(), creditor().token));
      expect(response.status).toBe(201);
    });

    it("a malicious organizationId/businessProfileId/orgId at the top level of the request body cannot set personal agreement tenancy", async () => {
      const polluted = {
        ...draftBody(),
        organizationId: orgAId,
        businessProfileId: orgAId,
        orgId: orgAId,
        workspace: { kind: "personal", organizationId: orgAId },
      };
      const response = await handlerFor()(postWithCookie(polluted, creditor().token));
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string };
      expect(wsCtx.agreementCtx.agreements.byId.get(body.id)?.organizationId).toBeNull();
    });
  });

  describe("organization", () => {
    it("OWNER with entitlement is allowed, and the server assigns the correct organizationId", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      // "Final RBAC Authorization Cutover": no authorization-time self-healing — the explicit
      // migration step is what gives this legacy-role-seeded membership a resolvable role_id at all.
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgAId);

      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string };
      expect(wsCtx.agreementCtx.agreements.byId.get(body.id)?.organizationId).toBe(orgAId);
    });

    it("FINANCE_ADMIN with entitlement is allowed", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "FINANCE_ADMIN" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgAId);
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(201);
    });

    it("AR_MANAGER with entitlement is allowed", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "AR_MANAGER" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgAId);
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(201);
    });

    it("AR_AGENT is denied under the conservative Phase-8 policy", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "AR_AGENT" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgAId);
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("VIEWER is denied", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "VIEWER" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgAId);
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("a non-member is denied", async () => {
      await seedEntitledPlan(orgAId);
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("a removed member is denied", async () => {
      const member = wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await wsCtx.orgAuthCtx.staffMembers.markRemoved(member.id, new Date());
      await seedEntitledPlan(orgAId);
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("a pending invitation (never accepted) grants no access", async () => {
      await seedEntitledPlan(orgAId);
      await wsCtx.orgAuthCtx.invitations.insert({
        businessProfileId: orgAId,
        email: "invitee@example.com",
        role: "FINANCE_ADMIN",
        customRoleId: null,
        invitedByUserId: randomUUID(),
        tokenHash: "unused-hash",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("an Org A member requesting Org B is denied", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgBId);
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgBId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("a disabled organization is denied", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgAId);
      await wsCtx.orgAuthCtx.businessProfiles.updateStatus(orgAId, "disabled");
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("a client-supplied organizationId cannot be substituted inside the workspace object by a non-member of the real target", async () => {
      // creditor is a member of orgA only; attempts to smuggle orgB's id into draftInput fields
      // (not the workspace selector itself) must never change which org is actually checked/assigned.
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      await wsCtx.orgAuthCtx.legacyMigration.migrateOrganization(orgAId);
      await seedEntitledPlan(orgAId);
      const polluted = { ...draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), organizationId: orgBId, businessProfileId: orgBId };
      const response = await handlerFor()(postWithCookie(polluted, creditor().token));
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string };
      expect(wsCtx.agreementCtx.agreements.byId.get(body.id)?.organizationId).toBe(orgAId);
    });
  });

  describe("entitlement", () => {
    it("OWNER with missing entitlement is denied", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("OWNER with an inactive subscription is denied", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "OWNER" });
      await seedEntitledPlan(orgAId);
      const sub = await wsCtx.entitlementCtx.subscriptions.findActiveByProfile("business", orgAId);
      await wsCtx.entitlementCtx.subscriptions.cancel(sub!.id);
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("FINANCE_ADMIN with missing entitlement is denied", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "FINANCE_ADMIN" });
      const before = countAllAgreements();
      const response = await handlerFor()(postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: orgAId } }), creditor().token));
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });

    it("personal creation is unaffected by any of the above", async () => {
      wsCtx.orgAuthCtx.staffMembers.seed({ businessProfileId: orgAId, userId: creditor().userId, role: "FINANCE_ADMIN" });
      const response = await handlerFor()(postWithCookie(draftBody(), creditor().token));
      expect(response.status).toBe(201);
    });
  });

  describe("fail-closed persistence", () => {
    it("every invalid organization mutation creates zero agreement rows of any kind (never a personal fallback)", async () => {
      const before = countAllAgreements();
      const response = await handlerFor()(
        postWithCookie(draftBody({ workspace: { kind: "organization", organizationId: randomUUID() } }), creditor().token),
      );
      expect(response.status).toBe(403);
      expect(countAllAgreements()).toBe(before);
    });
  });
});
