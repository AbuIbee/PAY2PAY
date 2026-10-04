import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { AuditService } from "@/lib/audit/auditService";
import { ProviderNotAvailableError } from "@/lib/errors";
import { InMemoryAuditEventRepository, TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { InMemorySubscriptionInvoiceRepository, InMemorySubscriptionPaymentMethodRepository } from "@/lib/organizations/platformBillingTestFakes";
import { PlatformBillingService } from "@/lib/organizations/platformBillingService";
import { createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { SandboxPlatformBillingProvider } from "@/test-support/organizations/sandboxPlatformBillingProvider";
import { seedCanonicalBusinessPlans } from "@/lib/pricing/seedCanonicalBusinessPlans";
import { InMemoryPricingPlanEntitlementRepository, InMemoryPricingPlanRepository, InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { PricingService } from "@/lib/pricing/pricingService";
import { createOrganizationBillingCancelHandler } from "./cancel/route";
import { createOrganizationBillingChangePlanHandler } from "./change-plan/route";
import { createOrganizationBillingPayInvoiceHandler } from "./pay-invoice/route";
import { createOrganizationBillingReactivateHandler } from "./reactivate/route";

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 10/14/15/25: the 4 billing mutation
 * routes — upgrade-only tier transitions (never a downgrade, never Enterprise self-selection),
 * provider NOT_CONFIGURED fails closed honestly, cross-tenant/permission denial, and cancel/reactivate
 * actually work locally regardless of provider configuration (Section 16's own local-first guarantee).
 */
describe("POST /api/organizations/billing/* mutation routes", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let plans: InMemoryPricingPlanRepository;
  let subscriptions: InMemorySubscriptionRepository;
  let invoices: InMemorySubscriptionInvoiceRepository;
  let paymentMethods: InMemorySubscriptionPaymentMethodRepository;
  let audit: AuditService;
  let pricing: PricingService;
  let organizationId: string;
  let ownerUserId: string;
  let ownerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    plans = new InMemoryPricingPlanRepository();
    const entitlements = new InMemoryPricingPlanEntitlementRepository();
    await seedCanonicalBusinessPlans(plans, entitlements);
    subscriptions = new InMemorySubscriptionRepository();
    invoices = new InMemorySubscriptionInvoiceRepository();
    paymentMethods = new InMemorySubscriptionPaymentMethodRepository();
    audit = new AuditService(new InMemoryAuditEventRepository());
    pricing = new PricingService(plans, subscriptions);

    const owner = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "billing-action-owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerUserId = owner.user.id;
    ownerToken = owner.token;

    const org = await orgCtx.businessProfiles.insert({
      ownerUserId,
      legalBusinessName: "Billing Action Test LLC",
      displayName: "Billing Action Test",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: ownerUserId, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
  });

  function postRequest(url: string, body: unknown, token?: string) {
    return new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token ? { cookie: `p2p_session=${token}` } : {}) } });
  }

  describe("change-plan", () => {
    it("upgrades Starter -> Core when a live provider is configured", async () => {
      const starter = await plans.findByCode("paid2you_business_starter");
      await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
      const provider = new SandboxPlatformBillingProvider("test-secret");
      const service = new PlatformBillingService(provider, subscriptions, plans, invoices, paymentMethods, audit);
      // The sandbox provider tracks its own internal subscription state, keyed by a reference IT
      // generates — register one for real via startSubscription rather than fabricating a string.
      const started = await provider.startSubscription({ providerCustomerReference: "cust-1", providerPaymentMethodReference: "pm-1", planCode: "paid2you_business_starter" });
      const sub = await subscriptions.findActiveByProfile("business", organizationId);
      await subscriptions.setProviderReferences(sub!.id, { providerCustomerReference: "cust-1", providerSubscriptionReference: started.providerSubscriptionReference });

      const handler = withErrorHandling("test", createOrganizationBillingChangePlanHandler(authCtx.authService, orgCtx.permissions, pricing, subscriptions, () => service));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/change-plan", { organizationId, planCode: "paid2you_business_core" }, ownerToken));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { pricingPlanId: string };
      const core = await plans.findByCode("paid2you_business_core");
      expect(body.pricingPlanId).toBe(core!.id);
    });

    it("rejects a downgrade attempt outright — never reaches PlatformBillingService.changePlan at all", async () => {
      const scale = await plans.findByCode("paid2you_business_scale");
      await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: scale!.id });
      const service = new PlatformBillingService(new SandboxPlatformBillingProvider("test-secret"), subscriptions, plans, invoices, paymentMethods, audit);
      const changePlanSpy = vi.spyOn(service, "changePlan");

      const handler = withErrorHandling("test", createOrganizationBillingChangePlanHandler(authCtx.authService, orgCtx.permissions, pricing, subscriptions, () => service));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/change-plan", { organizationId, planCode: "paid2you_business_starter" }, ownerToken));
      expect(response.status).toBe(403);
      expect(changePlanSpy).not.toHaveBeenCalled();
    });

    it("rejects Enterprise self-selection outright", async () => {
      const starter = await plans.findByCode("paid2you_business_starter");
      await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
      const service = new PlatformBillingService(new SandboxPlatformBillingProvider("test-secret"), subscriptions, plans, invoices, paymentMethods, audit);

      const handler = withErrorHandling("test", createOrganizationBillingChangePlanHandler(authCtx.authService, orgCtx.permissions, pricing, subscriptions, () => service));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/change-plan", { organizationId, planCode: "paid2you_business_enterprise" }, ownerToken));
      expect(response.status).toBe(400);
    });

    it("fails closed honestly when the billing provider is NOT_CONFIGURED", async () => {
      const starter = await plans.findByCode("paid2you_business_starter");
      await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
      const getBillingService = (): PlatformBillingService => {
        throw new ProviderNotAvailableError("No live platform billing provider is configured.");
      };

      const handler = withErrorHandling("test", createOrganizationBillingChangePlanHandler(authCtx.authService, orgCtx.permissions, pricing, subscriptions, getBillingService));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/change-plan", { organizationId, planCode: "paid2you_business_core" }, ownerToken));
      expect(response.status).toBe(503);
      const body = (await response.json()) as { message: string };
      expect(body.message).not.toContain("at getLazyPlatformBillingProvider"); // no raw stack/technical text leaks into the response.
    });

    it("denies a non-owner/non-subscription-manager", async () => {
      const starter = await plans.findByCode("paid2you_business_starter");
      await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
      const viewer = await authCtx.authService.signup({
        accountType: "personal",
        identity: TEST_SIGNUP_IDENTITY,
        inviteCode: null,
        email: "billing-action-viewer@example.com",
        password: "a-strong-password",
        dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
        ipAddress: null,
        userAgent: null,
      });
      await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: viewer.user.id, role: "VIEWER", customRoleId: null, isAuthorizedRepresentative: false });
      await orgCtx.legacyMigration.migrateOrganization(organizationId);
      const service = new PlatformBillingService(new SandboxPlatformBillingProvider("test-secret"), subscriptions, plans, invoices, paymentMethods, audit);

      const handler = withErrorHandling("test", createOrganizationBillingChangePlanHandler(authCtx.authService, orgCtx.permissions, pricing, subscriptions, () => service));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/change-plan", { organizationId, planCode: "paid2you_business_core" }, viewer.token));
      expect(response.status).toBe(403);
    });
  });

  describe("cancel / reactivate (local-first — Section 16)", () => {
    it("cancel succeeds and sets cancelAtPeriodEnd even though no live provider is configured", async () => {
      const starter = await plans.findByCode("paid2you_business_starter");
      await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
      // Mirrors the real getLazyPlatformBillingProvider: every method throws, but
      // PlatformBillingService.cancelAtPeriodEnd swallows that (best-effort) and still applies the
      // local state change.
      const throwingProvider = new SandboxPlatformBillingProvider("test-secret");
      const alwaysThrows = { ...throwingProvider, cancelAtPeriodEnd: async () => { throw new ProviderNotAvailableError("not configured"); } };
      const service = new PlatformBillingService(alwaysThrows as unknown as SandboxPlatformBillingProvider, subscriptions, plans, invoices, paymentMethods, audit);

      const handler = withErrorHandling("test", createOrganizationBillingCancelHandler(authCtx.authService, orgCtx.permissions, () => service));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/cancel", { organizationId }, ownerToken));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { cancelAtPeriodEnd: boolean };
      expect(body.cancelAtPeriodEnd).toBe(true);
    });

    it("reactivate succeeds locally even though no live provider is configured", async () => {
      const starter = await plans.findByCode("paid2you_business_starter");
      const sub = await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: starter!.id });
      await subscriptions.requestCancelAtPeriodEnd(sub.id);
      const throwingProvider = new SandboxPlatformBillingProvider("test-secret");
      const alwaysThrows = { ...throwingProvider, reactivate: async () => { throw new ProviderNotAvailableError("not configured"); } };
      const service = new PlatformBillingService(alwaysThrows as unknown as SandboxPlatformBillingProvider, subscriptions, plans, invoices, paymentMethods, audit);

      const handler = withErrorHandling("test", createOrganizationBillingReactivateHandler(authCtx.authService, orgCtx.permissions, () => service));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/reactivate", { organizationId }, ownerToken));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { cancelAtPeriodEnd: boolean };
      expect(body.cancelAtPeriodEnd).toBe(false);
    });
  });

  describe("pay-invoice", () => {
    it("fails closed honestly when the billing provider is NOT_CONFIGURED — never claims the invoice was paid", async () => {
      const getBillingService = (): PlatformBillingService => {
        throw new ProviderNotAvailableError("No live platform billing provider is configured.");
      };
      const handler = withErrorHandling("test", createOrganizationBillingPayInvoiceHandler(authCtx.authService, orgCtx.permissions, getBillingService));
      const response = await handler(postRequest("http://localhost/api/organizations/billing/pay-invoice", { organizationId, invoiceId: "00000000-0000-0000-0000-000000000000" }, ownerToken));
      expect(response.status).toBe(503);
    });

    it("rejects an unauthenticated request with 401", async () => {
      const service = new PlatformBillingService(new SandboxPlatformBillingProvider("test-secret"), subscriptions, plans, invoices, paymentMethods, audit);
      const handler = withErrorHandling("test", createOrganizationBillingPayInvoiceHandler(authCtx.authService, orgCtx.permissions, () => service));
      const response = await handler(new NextRequest("http://localhost/api/organizations/billing/pay-invoice", { method: "POST", body: JSON.stringify({ organizationId, invoiceId: "00000000-0000-0000-0000-000000000000" }), headers: { "content-type": "application/json" } }));
      expect(response.status).toBe(401);
    });
  });
});
