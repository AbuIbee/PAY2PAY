import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY } from "@/lib/organizations/arrangementUsageMetering";
import { InMemorySubscriptionInvoiceRepository, InMemorySubscriptionPaymentMethodRepository } from "@/lib/organizations/platformBillingTestFakes";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { InMemorySubscriptionUsageReader } from "@/lib/organizations/subscriptionUsageReaderTestFakes";
import { seedCanonicalBusinessPlans } from "@/lib/pricing/seedCanonicalBusinessPlans";
import { InMemoryPricingPlanEntitlementRepository, InMemoryPricingPlanRepository, InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { PricingService } from "@/lib/pricing/pricingService";
import { createOrganizationBillingGetHandler } from "./route";

describe("GET /api/organizations/billing (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 10/13/16/17)", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let plans: InMemoryPricingPlanRepository;
  let entitlements: InMemoryPricingPlanEntitlementRepository;
  let subscriptions: InMemorySubscriptionRepository;
  let invoices: InMemorySubscriptionInvoiceRepository;
  let paymentMethods: InMemorySubscriptionPaymentMethodRepository;
  let usage: InMemorySubscriptionUsageReader;
  let pricing: PricingService;
  let organizationId: string;
  let ownerUserId: string;
  let ownerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    plans = new InMemoryPricingPlanRepository();
    entitlements = new InMemoryPricingPlanEntitlementRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);
    subscriptions = new InMemorySubscriptionRepository();
    invoices = new InMemorySubscriptionInvoiceRepository();
    paymentMethods = new InMemorySubscriptionPaymentMethodRepository();
    usage = new InMemorySubscriptionUsageReader();
    pricing = new PricingService(plans, subscriptions);

    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "billing-owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerUserId = owner.user.id;
    ownerToken = owner.token;

    const org = await orgCtx.businessProfiles.insert({
      ownerUserId,
      legalBusinessName: "Billing Test LLC",
      displayName: "Billing Test",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: ownerUserId, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
  });

  function handler() {
    return withErrorHandling(
      "test",
      createOrganizationBillingGetHandler(authCtx.authService, orgCtx.permissions, orgCtx.businessProfiles, pricing, plans, subscriptions, invoices, paymentMethods, usage),
    );
  }

  function request(orgId: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/billing?organizationId=${orgId}`, { headers: token ? { cookie: `p2p_session=${token}` } : {} });
  }

  it("NOT_SUBSCRIBED: an organization with no subscription at all reports honest empty state — never a fabricated plan/usage", async () => {
    const response = await handler()(request(organizationId, ownerToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { subscriptionStatus: string; plan: unknown; usage: unknown; paymentMethod: unknown; invoices: unknown[] };
    expect(body.subscriptionStatus).toBe("NOT_SUBSCRIBED");
    expect(body.plan).toBeNull();
    expect(body.usage).toBeNull();
    expect(body.paymentMethod).toBeNull();
    expect(body.invoices).toEqual([]);
  });

  it("reports the real current plan, band, and usage for an active Starter subscription", async () => {
    const starter = await plans.findByCode("paid2you_business_starter");
    const sub = await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
    usage.seed({ subscriptionId: sub.id, metricKey: NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY, periodStart: new Date(Date.UTC(2026, 9, 1)), periodEnd: new Date(Date.UTC(2026, 10, 1)), count: 18 });
    await subscriptions.setBillingPeriod(sub.id, { currentPeriodStart: new Date(Date.UTC(2026, 9, 1)), currentPeriodEnd: new Date(Date.UTC(2026, 10, 1)) });

    const response = await handler()(request(organizationId, ownerToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { subscriptionStatus: string; plan: { code: string }; band: { min: number; max: number }; usage: { count: number } };
    expect(body.subscriptionStatus).toBe("ACTIVE");
    expect(body.plan.code).toBe("paid2you_business_starter");
    expect(body.band).toEqual({ min: 0, max: 24 });
    expect(body.usage.count).toBe(18);
  });

  it("PAST_DUE when the organization has a past_due invoice", async () => {
    const starter = await plans.findByCode("paid2you_business_starter");
    const sub = await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
    await invoices.insert({ organizationId, subscriptionId: sub.id, periodStart: new Date(), periodEnd: new Date(), amountDueMinorUnits: 9_900, dueAt: new Date(), providerInvoiceReference: null });
    await invoices.listForOrganization(organizationId).then((rows) => invoices.markStatus(rows[0]!.id, "past_due"));

    const response = await handler()(request(organizationId, ownerToken));
    const body = (await response.json()) as { subscriptionStatus: string; invoices: Array<{ status: string }> };
    expect(body.subscriptionStatus).toBe("PAST_DUE");
    expect(body.invoices).toHaveLength(1);
    expect(body.invoices[0]?.status).toBe("past_due");
  });

  it("CANCEL_AT_PERIOD_END when cancellation is pending", async () => {
    const starter = await plans.findByCode("paid2you_business_starter");
    const sub = await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
    await subscriptions.requestCancelAtPeriodEnd(sub.id);

    const response = await handler()(request(organizationId, ownerToken));
    const body = (await response.json()) as { subscriptionStatus: string; cancelAtPeriodEnd: boolean };
    expect(body.subscriptionStatus).toBe("CANCEL_AT_PERIOD_END");
    expect(body.cancelAtPeriodEnd).toBe(true);
  });

  it("never fabricates a payment method or invoices — reports null/empty honestly when none exist", async () => {
    const starter = await plans.findByCode("paid2you_business_starter");
    await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });

    const response = await handler()(request(organizationId, ownerToken));
    const body = (await response.json()) as { paymentMethod: unknown; invoices: unknown[]; providerConfigured: boolean };
    expect(body.paymentMethod).toBeNull();
    expect(body.invoices).toEqual([]);
    expect(body.providerConfigured).toBe(false); // no live PLATFORM_BILLING_PROVIDER in this test environment.
  });

  it("lists only real, strictly-higher-priced standard plans as available upgrades — never Enterprise, never a downgrade", async () => {
    const starter = await plans.findByCode("paid2you_business_starter");
    await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });

    const response = await handler()(request(organizationId, ownerToken));
    const body = (await response.json()) as { availableUpgrades: Array<{ code: string }> };
    const codes = body.availableUpgrades.map((p) => p.code);
    expect(codes).toContain("paid2you_business_core");
    expect(codes).toContain("paid2you_business_growth");
    expect(codes).toContain("paid2you_business_scale");
    expect(codes).not.toContain("paid2you_business_enterprise");
    expect(codes).not.toContain("paid2you_business_starter");
  });

  it("denies a non-member of the organization with 403", async () => {
    const outsider = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "billing-outsider@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(request(organizationId, outsider.token));
    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(request(organizationId));
    expect(response.status).toBe(401);
  });
});
