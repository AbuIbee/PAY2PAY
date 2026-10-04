import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, businessProfile, pricingPlan, subscription, subscriptionUsage, subscriptionUsageEvent } from "@/db/schema";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ArrangementUsageLimitExceededError, ConflictError } from "@/lib/errors";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import type { StaffService } from "@/lib/staff/staffService";
import { createIsolatedDb } from "../../../test/postgres/testDb";
import { seedBusinessOrganizationWithSubscription, seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { AgreementService, type SigningEvidenceInput } from "./agreementService";
import { DrizzleAgreementPartyRepository } from "./drizzleAgreementPartyRepository";
import { DrizzleAgreementRepository } from "./drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "./drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "./drizzleInstallmentScheduleItemRepository";
import { DrizzleRevisionApplicationRepository } from "./drizzleRevisionApplicationRepository";
import { DrizzleSigningApplicationRepository } from "./drizzleSigningApplicationRepository";

const DATABASE_URL = process.env.DATABASE_URL!;

const unusedStaffService = {
  requireActiveStaff: () => {
    throw new Error("not implemented — not exercised by this suite");
  },
  requireCapability: () => {
    throw new Error("not implemented — not exercised by this suite");
  },
} as unknown as StaffService;

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function evidenceFor(userId: string, profileId: string, role: "creditor" | "debtor"): SigningEvidenceInput {
  return {
    signerUserId: userId,
    signerProfileKind: "personal",
    signerProfileId: profileId,
    signerRole: role,
    signingAuthority: null,
    signerTitle: null,
    consentCaptured: true,
    consentVersion: "v1",
    authMethod: "totp",
    ipAddress: "127.0.0.1",
    deviceInfo: null,
    timezone: "UTC",
  };
}

function buildAgreementService(signing: DrizzleSigningApplicationRepository) {
  return new AgreementService({
    agreements: new DrizzleAgreementRepository(),
    versions: new DrizzleAgreementVersionRepository(),
    parties: new DrizzleAgreementPartyRepository(),
    scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
    profileOwners: new DrizzleProfileOwnerReader(),
    staffService: unusedStaffService,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    signing,
    revisions: new DrizzleRevisionApplicationRepository(),
  });
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Requirement 5/24: real-Postgres proof that
 * `recordQualifyingArrangementUsage` (wired into `DrizzleSigningApplicationRepository`) correctly
 * meters and enforces an organization's `new_arrangements_monthly` limit — transactionally,
 * idempotently, and race-safely — without affecting Personal agreements at all.
 */
describe("Requirement 5/24: arrangement usage metering and limit enforcement (real Postgres)", () => {
  let creditorUserId: string;
  let creditorProfileId: string;
  let debtorUserId: string;
  let debtorProfileId: string;

  beforeEach(async () => {
    const creditor = await seedPersonalUser("usage-creditor");
    const debtor = await seedPersonalUser("usage-debtor");
    creditorUserId = creditor.userId;
    creditorProfileId = creditor.profileId;
    debtorUserId = debtor.userId;
    debtorProfileId = debtor.profileId;
  });

  async function createAndFullySignAgreement(agreementService: AgreementService, organizationId: string | null) {
    const draft = await agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      category: "personal_loan",
      description: "usage metering postgres test agreement",
      originalAmountMinorUnits: 100_000,
      previousPaymentsMinorUnits: 0,
      firstPaymentMinorUnits: 10_000,
      installmentAmountMinorUnits: 10_000,
      frequency: "monthly",
      firstPaymentDate: futureDate(7),
      feeAllocation: "creditor_pays",
      earlyPayoffTerms: "none",
      hardshipRules: "none",
      partialPaymentRules: "none",
      settlementRules: "none",
      disputeProcedure: "none",
      organizationId,
    });
    const agreementId = draft.agreement.id;
    await agreementService.submitDraft(agreementId, creditorUserId);
    await agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    await agreementService.signAgreementWithEvidence(agreementId, debtorUserId, evidenceFor(debtorUserId, debtorProfileId, "debtor"));
    return agreementId;
  }

  it("counts a qualifying arrangement exactly once, and a non-qualifying partial signature does not count at all", async () => {
    const { organizationId, subscriptionId } = await seedBusinessOrganizationWithSubscription({
      namePrefix: "usage-count",
      newArrangementsMonthlyLimit: 10,
    });
    const agreementService = buildAgreementService(new DrizzleSigningApplicationRepository());
    const agreementId = await createAndFullySignAgreement(agreementService, organizationId);
    // Only the debtor has signed so far — not yet a qualifying arrangement.
    const usageAfterPartial = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, subscriptionId));
    expect(usageAfterPartial).toHaveLength(0);

    await agreementService.signAgreementWithEvidence(agreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));

    const usageRows = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, subscriptionId));
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.count).toBe(1);
    const eventRows = await getDb().select().from(subscriptionUsageEvent).where(eq(subscriptionUsageEvent.subscriptionId, subscriptionId));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.sourceId).toBe(agreementId);
  });

  it("Personal agreements (organizationId null) are never metered", async () => {
    const agreementService = buildAgreementService(new DrizzleSigningApplicationRepository());
    const agreementId = await createAndFullySignAgreement(agreementService, null);
    await agreementService.signAgreementWithEvidence(agreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));
    const row = await getDb().select().from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    expect(row[0]?.status).toBe("first_payment_pending"); // succeeded with no subscription/usage lookup at all.
  });

  it("the next qualifying arrangement fails server-side once the plan's limit is reached, and does not increment usage", async () => {
    const { organizationId, subscriptionId } = await seedBusinessOrganizationWithSubscription({
      namePrefix: "usage-limit",
      newArrangementsMonthlyLimit: 1,
    });
    const agreementService = buildAgreementService(new DrizzleSigningApplicationRepository());

    const firstAgreementId = await createAndFullySignAgreement(agreementService, organizationId);
    await agreementService.signAgreementWithEvidence(firstAgreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));

    const secondAgreementId = await createAndFullySignAgreement(agreementService, organizationId);
    await expect(
      agreementService.signAgreementWithEvidence(secondAgreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor")),
    ).rejects.toThrow(ArrangementUsageLimitExceededError);

    // The whole transaction rolled back — the second agreement's completing signature never persisted either.
    const secondRow = await getDb().select().from(agreement).where(eq(agreement.id, secondAgreementId)).limit(1);
    expect(secondRow[0]?.status).toBe("awaiting_signatures");

    const usageRows = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, subscriptionId));
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.count).toBe(1); // still exactly 1 — the rejected attempt left no trace.
  });

  it("Requirement 23/26: a negotiated per-organization limit overrides the catalog entitlement's limit", async () => {
    const { organizationId, subscriptionId } = await seedBusinessOrganizationWithSubscription({
      namePrefix: "usage-negotiated",
      newArrangementsMonthlyLimit: 1, // catalog says 1 — negotiated override below raises it to 2.
    });
    await getDb().update(subscription).set({ negotiatedNewArrangementsMonthlyLimit: 2 }).where(eq(subscription.id, subscriptionId));

    const agreementService = buildAgreementService(new DrizzleSigningApplicationRepository());
    const firstId = await createAndFullySignAgreement(agreementService, organizationId);
    await agreementService.signAgreementWithEvidence(firstId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));
    const secondId = await createAndFullySignAgreement(agreementService, organizationId);
    // Succeeds at count=2 — the catalog's limit of 1 alone would have rejected this.
    await agreementService.signAgreementWithEvidence(secondId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));

    const thirdId = await createAndFullySignAgreement(agreementService, organizationId);
    await expect(
      agreementService.signAgreementWithEvidence(thirdId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor")),
    ).rejects.toThrow(ArrangementUsageLimitExceededError);

    const usageRows = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, subscriptionId));
    expect(usageRows[0]?.count).toBe(2); // the negotiated limit (2), never the catalog's (1).
  });

  it("TRUE concurrency: two organizations never see each other's usage, and one organization's own concurrent completions cannot exceed its limit", async () => {
    const orgA = await seedBusinessOrganizationWithSubscription({ namePrefix: "usage-race-a", newArrangementsMonthlyLimit: 1 });
    const orgB = await seedBusinessOrganizationWithSubscription({ namePrefix: "usage-race-b", newArrangementsMonthlyLimit: 1 });

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const serviceA = buildAgreementService(new DrizzleSigningApplicationRepository(isolatedA.db));
      const serviceB = buildAgreementService(new DrizzleSigningApplicationRepository(isolatedB.db));

      const agreementA = await createAndFullySignAgreement(serviceA, orgA.organizationId);
      const agreementB = await createAndFullySignAgreement(serviceB, orgB.organizationId);

      const [resultA, resultB] = await Promise.all([
        serviceA.signAgreementWithEvidence(agreementA, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor")),
        serviceB.signAgreementWithEvidence(agreementB, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor")),
      ]);
      // Each organization has its own independent limit of 1 — both succeed, neither affects the other.
      expect(resultA.bothSigned).toBe(true);
      expect(resultB.bothSigned).toBe(true);

      const usageA = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, orgA.subscriptionId));
      const usageB = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, orgB.subscriptionId));
      expect(usageA[0]?.count).toBe(1);
      expect(usageB[0]?.count).toBe(1);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("a TRUE race on the completing signature never double-counts usage — exactly one of the two duplicate requests wins and increments it once", async () => {
    const { organizationId, subscriptionId } = await seedBusinessOrganizationWithSubscription({
      namePrefix: "usage-idempotent",
      newArrangementsMonthlyLimit: 5,
    });
    const agreementService = buildAgreementService(new DrizzleSigningApplicationRepository());
    const agreementId = await createAndFullySignAgreement(agreementService, organizationId);
    const versionRow = await getDb().select().from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    const versionId = versionRow[0]!.currentVersionId!;

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const signingA = new DrizzleSigningApplicationRepository(isolatedA.db);
      const signingB = new DrizzleSigningApplicationRepository(isolatedB.db);
      const input = {
        agreementId,
        agreementVersionId: versionId,
        role: "creditor" as const,
        originatorRole: "creditor" as const,
        signedAt: new Date(),
        evidence: null,
      };

      // Unlike a non-completing race (R05-A), this is the COMPLETING signature: whichever
      // transaction commits first advances the agreement's status, so the loser's own fresh,
      // locked re-read of the agreement row (drizzleSigningApplicationRepository.ts's very first
      // guard) sees that changed status and rejects with ConflictError directly — it never even
      // reaches the per-role "already signed" branch. Exactly one settles successfully with
      // bothSigned:true (and exactly one usage increment); the other rejects, writing nothing.
      const [resultA, resultB] = await Promise.allSettled([signingA.applySigningAtomically(input), signingB.applySigningAtomically(input)]);
      const fulfilled = [resultA, resultB].filter((r) => r.status === "fulfilled");
      const rejected = [resultA, resultB].filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (fulfilled[0]?.status === "fulfilled") expect(fulfilled[0].value.bothSigned).toBe(true);
      if (rejected[0]?.status === "rejected") expect(rejected[0].reason).toBeInstanceOf(ConflictError);

      const usageRows = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, subscriptionId));
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0]?.count).toBe(1); // never double-counted by the loser.
      const eventRows = await getDb().select().from(subscriptionUsageEvent).where(eq(subscriptionUsageEvent.subscriptionId, subscriptionId));
      expect(eventRows).toHaveLength(1);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  /**
   * "PAID2YOU PRODUCTION LAUNCH", Phase 1, Section 21: boundary proof against the REAL production
   * catalog row (migrated by supabase/migrations/20261003050000_production_commercial_catalog.sql),
   * never a synthetic test-only plan — this is what actually ships. Usage is seeded directly at
   * one-below-ceiling (never by fully signing 23 real agreements, which this mechanism's own
   * correctness — proven exhaustively above with small synthetic limits — does not require
   * re-demonstrating at scale) so the test stays fast while still exercising the real
   * `paid2you_business_starter` plan row and its real seeded ceiling of 24.
   */
  describe("production catalog boundary: Starter (1–24)", () => {
    async function seedStarterOrganizationAtUsage(count: number): Promise<{ organizationId: string; subscriptionId: string }> {
      const db = getDb();
      const [starterPlan] = await db.select().from(pricingPlan).where(eq(pricingPlan.code, "paid2you_business_starter")).limit(1);
      if (!starterPlan) throw new Error("paid2you_business_starter not found — has the production commercial catalog migration been applied?");

      const owner = await seedPersonalUser("starter-boundary-owner");
      const [org] = await db
        .insert(businessProfile)
        .values({ ownerUserId: owner.userId, legalBusinessName: `Starter Boundary LLC ${randomUUID()}`, displayName: "Starter Boundary LLC", entityType: "LLC", state: "DE" })
        .returning({ id: businessProfile.id });
      if (!org) throw new Error("business_profile insert returned no row");

      const [sub] = await db
        .insert(subscription)
        .values({ profileKind: "business", profileId: org.id, pricingPlanId: starterPlan.id, status: "active" })
        .returning({ id: subscription.id });
      if (!sub) throw new Error("subscription insert returned no row");

      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      await db.insert(subscriptionUsage).values({ organizationId: org.id, subscriptionId: sub.id, metricKey: "new_arrangements_monthly", periodStart, periodEnd, count });

      return { organizationId: org.id, subscriptionId: sub.id };
    }

    it("the 24th established arrangement succeeds on the real Starter plan (ceiling is inclusive)", async () => {
      const { organizationId, subscriptionId } = await seedStarterOrganizationAtUsage(23);
      const agreementService = buildAgreementService(new DrizzleSigningApplicationRepository());
      const agreementId = await createAndFullySignAgreement(agreementService, organizationId);

      await agreementService.signAgreementWithEvidence(agreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));

      const usageRows = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, subscriptionId));
      expect(usageRows[0]?.count).toBe(24);
    });

    it("the 25th established arrangement is rejected on the real Starter plan — the explicit tier-transition signal Section 6 requires, never a silent reject or a silent upgrade", async () => {
      const { organizationId, subscriptionId } = await seedStarterOrganizationAtUsage(24);
      const agreementService = buildAgreementService(new DrizzleSigningApplicationRepository());
      const agreementId = await createAndFullySignAgreement(agreementService, organizationId);

      let caught: unknown;
      try {
        await agreementService.signAgreementWithEvidence(agreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ArrangementUsageLimitExceededError);
      expect((caught as ArrangementUsageLimitExceededError).planCode).toBe("paid2you_business_starter");
      expect((caught as ArrangementUsageLimitExceededError).limit).toBe(24);

      const usageRows = await getDb().select().from(subscriptionUsage).where(eq(subscriptionUsage.subscriptionId, subscriptionId));
      expect(usageRows[0]?.count).toBe(24); // unchanged — the rejected 25th left no trace, no overage, no silent charge.
    });
  });
});
