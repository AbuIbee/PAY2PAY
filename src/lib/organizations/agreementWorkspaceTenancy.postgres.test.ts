import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, businessProfile, businessStaffMember, pricingPlan, pricingPlanEntitlement } from "@/db/schema";
import { AgreementService } from "@/lib/agreements/agreementService";
import { DrizzleAgreementPartyRepository } from "@/lib/agreements/drizzleAgreementPartyRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "@/lib/agreements/drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "@/lib/agreements/drizzleInstallmentScheduleItemRepository";
import { DrizzleRevisionApplicationRepository } from "@/lib/agreements/drizzleRevisionApplicationRepository";
import { DrizzleSigningApplicationRepository } from "@/lib/agreements/drizzleSigningApplicationRepository";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzlePricingPlanEntitlementRepository } from "@/lib/pricing/drizzlePricingPlanEntitlementRepository";
import { DrizzlePricingPlanRepository } from "@/lib/pricing/drizzlePricingPlanRepository";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";
import { PricingService } from "@/lib/pricing/pricingService";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzleBusinessStaffMemberRepository } from "@/lib/staff/drizzleBusinessStaffMemberRepository";
import { getStaffService } from "@/lib/staff/getStaffService";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { AgreementWorkspaceService } from "./agreementWorkspaceService";
import { ORGANIZATION_AGREEMENTS_FEATURE_KEY } from "./entitlementFeatureKeys";
import { EntitlementService } from "./entitlementService";
import { OrganizationAuthorizationService } from "./organizationAuthorizationService";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 8 (2026-10-02),
 * item 11: real-Postgres proof that `agreement.organization_id` actually persists and is actually
 * tenant-scoped against a genuine migrated database — not merely the in-memory fakes
 * agreementWorkspaceService.test.ts already proves this contract against. Every repository wired
 * below is the real Drizzle implementation. Both agreements in this file use PERSONAL
 * creditor/debtor profiles deliberately — organizationId is pure tenancy, orthogonal to party
 * identity (see AgreementWorkspaceService's own doc comment), so this isolates "did the tenancy
 * column persist/scope correctly" from AgreementService's own, separately-tested party-authorization
 * path, exactly as signingConcurrency.postgres.test.ts's `unusedStaffService` stub does for the same
 * reason — `staffService` here is never actually called (both parties are always personal).
 */
const unusedStaffService = {
  requireActiveStaff: () => {
    throw new Error("not implemented — no business profile is ever used as a creditor/debtor party in this suite");
  },
  requireCapability: () => {
    throw new Error("not implemented — no business profile is ever used as a creditor/debtor party in this suite");
  },
} as unknown as import("@/lib/staff/staffService").StaffService;

function buildAgreementService() {
  return new AgreementService({
    agreements: new DrizzleAgreementRepository(),
    versions: new DrizzleAgreementVersionRepository(),
    parties: new DrizzleAgreementPartyRepository(),
    scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
    profileOwners: new DrizzleProfileOwnerReader(),
    staffService: unusedStaffService,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    signing: new DrizzleSigningApplicationRepository(),
    revisions: new DrizzleRevisionApplicationRepository(),
  });
}

function buildAgreementWorkspaceService(agreementService: AgreementService) {
  const orgAuth = new OrganizationAuthorizationService(
    new DrizzleBusinessProfileRepository(),
    new DrizzleBusinessStaffMemberRepository(),
    getStaffService(),
  );
  const entitlementService = new EntitlementService(
    new PricingService(new DrizzlePricingPlanRepository(), new DrizzleSubscriptionRepository()),
    new DrizzlePricingPlanEntitlementRepository(),
  );
  return new AgreementWorkspaceService(agreementService, orgAuth, entitlementService);
}

function draftTerms(creditorProfileId: string, debtorProfileId: string) {
  return {
    creditor: { kind: "personal" as const, id: creditorProfileId },
    debtor: { kind: "personal" as const, id: debtorProfileId },
    category: "personal_loan",
    description: "Postgres tenancy proof",
    originalAmountMinorUnits: 50_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 10_000,
    installmentAmountMinorUnits: 10_000,
    frequency: "monthly" as const,
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays" as const,
    earlyPayoffTerms: "No penalty.",
    hardshipRules: "Hardship relief available.",
    partialPaymentRules: "Creditor approval required.",
    settlementRules: "Either party may propose.",
    disputeProcedure: "Per platform policy.",
  };
}

async function seedOrganization(): Promise<string> {
  const db = getDb();
  const owner = await seedPersonalUser("phase8-org-owner");
  const [org] = await db
    .insert(businessProfile)
    .values({
      ownerUserId: owner.userId,
      legalBusinessName: `Postgres Tenancy Test LLC ${randomUUID()}`,
      displayName: "Postgres Tenancy Test",
      entityType: "llc",
      businessAddress: {},
      country: "US",
      state: "IL",
    })
    .returning({ id: businessProfile.id });
  if (!org) throw new Error("seedOrganization: business_profile insert returned no row");
  return org.id;
}

async function seedEntitledOrganizationMembership(organizationId: string, userId: string): Promise<void> {
  const db = getDb();
  await db.insert(businessStaffMember).values({
    businessProfileId: organizationId,
    userId,
    role: "OWNER",
    isAuthorizedRepresentative: true,
  });
  const [plan] = await db
    .insert(pricingPlan)
    .values({ kind: "business", code: `pg-test-plan-${randomUUID()}`, name: "Postgres Test Plan" })
    .returning({ id: pricingPlan.id });
  if (!plan) throw new Error("seedEntitledOrganizationMembership: pricing_plan insert returned no row");
  await new DrizzleSubscriptionRepository().insert({ profileKind: "business", profileId: organizationId, pricingPlanId: plan.id });
  await db
    .insert(pricingPlanEntitlement)
    .values({ pricingPlanId: plan.id, featureKey: ORGANIZATION_AGREEMENTS_FEATURE_KEY, enabled: true, limitValue: null });
}

describe("Phase 8: agreement.organization_id real-Postgres tenancy proof", () => {
  let agreementService: AgreementService;
  let agreementWorkspaceService: AgreementWorkspaceService;
  let creditorUserId: string;
  let creditorProfileId: string;
  let debtorProfileId: string;

  beforeEach(async () => {
    agreementService = buildAgreementService();
    agreementWorkspaceService = buildAgreementWorkspaceService(agreementService);
    const creditor = await seedPersonalUser("phase8-creditor");
    const debtor = await seedPersonalUser("phase8-debtor");
    creditorUserId = creditor.userId;
    creditorProfileId = creditor.profileId;
    debtorProfileId = debtor.profileId;
  });

  it("a personal agreement persists with organization_id IS NULL", async () => {
    const result = await agreementWorkspaceService.createDraftForWorkspace({
      userId: creditorUserId,
      workspaceSelector: { kind: "personal" },
      draftInput: draftTerms(creditorProfileId, debtorProfileId),
    });

    const db = getDb();
    const rows = await db.select().from(agreement).where(eq(agreement.id, result.agreement.id)).limit(1);
    expect(rows[0]?.organizationId).toBeNull();
  });

  it("an organization agreement persists with organization_id equal to the validated organization, and is retrievable only via that organization's tenant-scoped lookup", async () => {
    const organizationId = await seedOrganization();
    await seedEntitledOrganizationMembership(organizationId, creditorUserId);

    const result = await agreementWorkspaceService.createDraftForWorkspace({
      userId: creditorUserId,
      workspaceSelector: { kind: "organization", organizationId },
      draftInput: draftTerms(creditorProfileId, debtorProfileId),
    });

    const agreements = new DrizzleAgreementRepository();
    const direct = await agreements.findById(result.agreement.id);
    expect(direct?.organizationId).toBe(organizationId);

    const scoped = await agreements.findOrganizationAgreement(organizationId, result.agreement.id);
    expect(scoped).not.toBeNull();

    const otherOrgId = await seedOrganization();
    const crossTenant = await agreements.findOrganizationAgreement(otherOrgId, result.agreement.id);
    expect(crossTenant).toBeNull();
  });

  it("duplicate membership rejected at the database level: a second active business_staff_member row for the same (business_profile_id, user_id) violates the partial unique index", async () => {
    const organizationId = await seedOrganization();
    const db = getDb();
    await db.insert(businessStaffMember).values({
      businessProfileId: organizationId,
      userId: creditorUserId,
      role: "OWNER",
      isAuthorizedRepresentative: true,
    });

    await expect(
      db.insert(businessStaffMember).values({
        businessProfileId: organizationId,
        userId: creditorUserId,
        role: "FINANCE_ADMIN",
        isAuthorizedRepresentative: false,
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(businessStaffMember).where(eq(businessStaffMember.businessProfileId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("OWNER");
  });
});
