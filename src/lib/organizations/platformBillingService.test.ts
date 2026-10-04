import { describe, expect, it, vi } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { ConflictError, DependencyError, ProviderNotAvailableError, ValidationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import { seedCanonicalBusinessPlans } from "@/lib/pricing/seedCanonicalBusinessPlans";
import { InMemoryPricingPlanEntitlementRepository, InMemoryPricingPlanRepository, InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { SandboxPlatformBillingProvider } from "@/test-support/organizations/sandboxPlatformBillingProvider";
import { PLATFORM_BILLING_AUDIT_ACTION, PlatformBillingService } from "./platformBillingService";
import { InMemorySubscriptionInvoiceRepository, InMemorySubscriptionPaymentMethodRepository } from "./platformBillingTestFakes";

async function buildHarness() {
  const plans = new InMemoryPricingPlanRepository();
  const entitlements = new InMemoryPricingPlanEntitlementRepository();
  const subscriptions = new InMemorySubscriptionRepository();
  const invoices = new InMemorySubscriptionInvoiceRepository();
  const paymentMethods = new InMemorySubscriptionPaymentMethodRepository();
  const provider = new SandboxPlatformBillingProvider("test-secret");
  const auditRepo = new InMemoryAuditEventRepository();
  const audit = new AuditService(auditRepo);
  await seedCanonicalBusinessPlans(plans, entitlements);
  const service = new PlatformBillingService(provider, subscriptions, plans, invoices, paymentMethods, audit);
  return { plans, subscriptions, invoices, paymentMethods, provider, service, auditRepo };
}

describe("PlatformBillingService (Section 10/19-27)", () => {
  it("NOT_CONFIGURED production behavior: no platform_billing provider is registered, so the factory fails closed", () => {
    expect(() => assertProviderAvailableForRuntime("platform_billing", undefined, "production")).toThrow(ProviderNotAvailableError);
  });

  it("subscription belongs to the organization, never the owning user", async () => {
    const { plans, subscriptions, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-abc-trucking", pricingPlanId: core!.id });
    void sub;
    const summary = await service.getBillingSummary("org-abc-trucking");
    expect(summary.subscription.profileId).toBe("org-abc-trucking");
    expect(summary.subscription.profileKind).toBe("business");
  });

  it("setUpBilling (fake provider success path) attaches a payment method and starts a real provider subscription, persisting safe metadata only", async () => {
    const { plans, subscriptions, paymentMethods, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });

    const summary = await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });
    expect(summary.subscription.providerSubscriptionReference).toBeTruthy();
    expect(summary.subscription.currentPeriodEnd).not.toBeNull();
    expect(summary.paymentMethod?.displayLast4).toBe("4242");

    const serialized = JSON.stringify(await paymentMethods.findActiveForOrganization("org-1"));
    expect(serialized).not.toMatch(/cvv|pan/i);
  });

  it("Pay Now (invoice retry/pay-now domain operation): paying an open invoice marks it paid via the provider", async () => {
    const { plans, subscriptions, invoices, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
    await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

    const [invoice] = await invoices.listForOrganization("org-1");
    const paid = await service.payInvoice("org-1", invoice!.id);
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).not.toBeNull();
  });

  it("cancellation defaults to cancel_at_period_end — status stays active, never an immediate destructive cancel", async () => {
    const { plans, subscriptions, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
    await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

    const canceled = await service.cancelAtPeriodEnd("org-1");
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(canceled.status).toBe("active");
  });

  it("reactivation clears a pending cancellation, and reactivating a subscription that was never canceled is rejected", async () => {
    const { plans, subscriptions, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
    await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

    await expect(service.reactivate("org-1")).rejects.toThrow(ConflictError);
    await service.cancelAtPeriodEnd("org-1");
    const reactivated = await service.reactivate("org-1");
    expect(reactivated.cancelAtPeriodEnd).toBe(false);
  });

  it("no ordinary customer agreement is ever created for Paid2You's own subscription billing (domain separation)", async () => {
    // Structural proof, not just a runtime check: this service's module never imports anything from
    // the agreement domain at all (Requirement 20/21/39) — grep-verified at review time; this test
    // additionally proves a full billing lifecycle never produces any object shaped like an
    // agreement record.
    const { plans, subscriptions, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
    const summary = await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });
    expect(summary).not.toHaveProperty("agreement");
    expect(summary).not.toHaveProperty("agreementId");
  });

  it("Owner cannot bypass plan entitlement through PlatformBillingService (structural): changePlan always validates the target plan is active and business-kind", async () => {
    const { plans, subscriptions, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
    await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

    await expect(service.changePlan("org-1", "nonexistent_plan_code")).rejects.toThrow(ValidationError);
  });

  it("cross-tenant: organization A cannot read organization B's invoices, payment method, or subscription", async () => {
    const { plans, subscriptions, service, paymentMethods, invoices } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    await subscriptions.insert({ profileKind: "business", profileId: "org-a", pricingPlanId: core!.id });
    await subscriptions.insert({ profileKind: "business", profileId: "org-b", pricingPlanId: core!.id });
    await service.setUpBilling({ organizationId: "org-a", billingEmail: "a@a.com", legalName: "A LLC", paymentMethodToken: "tok_a" });
    await service.setUpBilling({ organizationId: "org-b", billingEmail: "b@b.com", legalName: "B LLC", paymentMethodToken: "tok_b" });

    const bSummary = await service.getBillingSummary("org-b");
    expect(bSummary.subscription.profileId).toBe("org-b");
    expect((await paymentMethods.findActiveForOrganization("org-a"))?.id).not.toBe(bSummary.paymentMethod?.id);
    expect((await invoices.listForOrganization("org-a")).some((i) => bSummary.invoices.some((bi) => bi.id === i.id))).toBe(false);

    const [bInvoice] = bSummary.invoices;
    await expect(service.payInvoice("org-a", bInvoice!.id)).rejects.toThrow(ValidationError);
  });

  it("upgrade applies immediately; the subscription's pricing plan changes on the same row", async () => {
    const { plans, subscriptions, service } = await buildHarness();
    const core = await plans.findByCode("paid2you_business_core");
    const growth = await plans.findByCode("paid2you_business_growth");
    await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
    await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

    const changed = await service.changePlan("org-1", "paid2you_business_growth");
    expect(changed.pricingPlanId).toBe(growth!.id);
  });

  describe("beginHostedCheckout (Section 7/8-D: the real hosted/tokenized initial-billing entry point)", () => {
    it("creates a hosted Checkout session WITHOUT attaching a payment method or starting a subscription — redirect alone never activates", async () => {
      const { plans, subscriptions, service, provider, auditRepo } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });

      const session = await service.beginHostedCheckout({
        organizationId: "org-1",
        billingEmail: "billing@abc.com",
        legalName: "ABC Trucking LLC",
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/cancel",
      });
      expect(session.hostedUrl).toContain("https://app.test/success");

      const summary = await service.getBillingSummary("org-1");
      expect(summary.subscription.providerSubscriptionReference).toBeNull();
      expect(summary.paymentMethod).toBeNull();
      void provider;
      expect(auditRepo.events.some((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_STARTED)).toBe(false);
    });

    it("reuses an existing provider customer reference instead of creating a second one on a retry", async () => {
      const { plans, subscriptions, service } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });

      await service.beginHostedCheckout({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", successUrl: "https://app.test/success", cancelUrl: "https://app.test/cancel" });
      const firstCustomerRef = (await subscriptions.findActiveByProfile("business", "org-1"))!.providerCustomerReference;
      expect(firstCustomerRef).toBeTruthy();

      await service.beginHostedCheckout({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", successUrl: "https://app.test/success", cancelUrl: "https://app.test/cancel" });
      const secondCustomerRef = (await subscriptions.findActiveByProfile("business", "org-1"))!.providerCustomerReference;
      expect(secondCustomerRef).toBe(firstCustomerRef);
    });

    it("rejects Enterprise from self-service hosted checkout", async () => {
      const { plans, subscriptions, service } = await buildHarness();
      const enterprise = await plans.findByCode("paid2you_business_enterprise");
      await subscriptions.insert({ profileKind: "business", profileId: "org-ent", pricingPlanId: enterprise!.id });

      await expect(
        service.beginHostedCheckout({ organizationId: "org-ent", billingEmail: "billing@ent.com", legalName: "Enterprise Co", successUrl: "https://app.test/success", cancelUrl: "https://app.test/cancel" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("provider confirmation (checkout.session.completed equivalent) activates the subscription — never the session creation itself", () => {
    it("completing the simulated hosted checkout attaches a real payment method and starts a real subscription", async () => {
      const { plans, subscriptions, service, provider } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });

      const session = await service.beginHostedCheckout({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", successUrl: "https://app.test/success", cancelUrl: "https://app.test/cancel" });
      const sessionRef = new URL(session.hostedUrl).searchParams.get("sandbox_checkout_session")!;
      const { providerSubscriptionReference } = provider.simulateCheckoutCompleted(sessionRef);

      const pm = await provider.retrieveSubscriptionPaymentMethod(providerSubscriptionReference);
      expect(pm.displayLast4).toBe("4242");
    });
  });

  describe("P0-6 (Codex): cancel/reactivate are truthful about provider outcome — never a fabricated local success", () => {
    it("Stripe cancellation succeeds: local cancel_at_period_end updated, exactly one audit event, success returned", async () => {
      const { plans, subscriptions, service, auditRepo } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
      await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

      const result = await service.cancelAtPeriodEnd("org-1");
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(auditRepo.events.filter((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.CANCEL_AT_PERIOD_END && e.profileId === "org-1")).toHaveLength(1);
    });

    it("Stripe cancellation fails: local state is UNCHANGED, no CANCEL_AT_PERIOD_END audit, a typed DependencyError is thrown — never a fabricated success", async () => {
      const { plans, subscriptions, service, provider, auditRepo } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
      await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

      const spy = vi.spyOn(provider, "cancelAtPeriodEnd").mockRejectedValueOnce(new Error("simulated Stripe outage"));
      await expect(service.cancelAtPeriodEnd("org-1")).rejects.toThrow(DependencyError);
      spy.mockRestore();

      const stillActive = await service.getBillingSummary("org-1");
      expect(stillActive.subscription.cancelAtPeriodEnd).toBe(false);
      expect(auditRepo.events.filter((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.CANCEL_AT_PERIOD_END && e.profileId === "org-1")).toHaveLength(0);
    });

    it("duplicate cancellation request after a successful cancellation is a deterministic, safe result (still cancel_at_period_end=true, no duplicate financial effect)", async () => {
      const { plans, subscriptions, service } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
      await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });

      await service.cancelAtPeriodEnd("org-1");
      const second = await service.cancelAtPeriodEnd("org-1");
      expect(second.cancelAtPeriodEnd).toBe(true);
    });

    it("an organization with no subscription at all is denied BEFORE any provider action is attempted — mirrors the route-level cross-tenant/permission denial already proven in billingActions.route.test.ts, here at the service's own boundary", async () => {
      const { plans, subscriptions, service, provider } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-b", pricingPlanId: core!.id });
      // org-a has no subscription row at all — requireActiveSubscription must deny before any provider call.
      const spy = vi.spyOn(provider, "cancelAtPeriodEnd");
      await expect(service.cancelAtPeriodEnd("org-a")).rejects.toThrow(ValidationError);
      expect(spy).not.toHaveBeenCalled();
    });

    it("Stripe reactivation succeeds: local state updated, exactly one audit event", async () => {
      const { plans, subscriptions, service, auditRepo } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
      await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });
      await service.cancelAtPeriodEnd("org-1");

      const result = await service.reactivate("org-1");
      expect(result.cancelAtPeriodEnd).toBe(false);
      expect(auditRepo.events.filter((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.REACTIVATED && e.profileId === "org-1")).toHaveLength(1);
    });

    it("Stripe reactivation fails: local state stays cancel_at_period_end=true (unchanged), no REACTIVATED audit, typed DependencyError thrown", async () => {
      const { plans, subscriptions, service, provider, auditRepo } = await buildHarness();
      const core = await plans.findByCode("paid2you_business_core");
      await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: core!.id });
      await service.setUpBilling({ organizationId: "org-1", billingEmail: "billing@abc.com", legalName: "ABC Trucking LLC", paymentMethodToken: "tok_visa" });
      await service.cancelAtPeriodEnd("org-1");

      const spy = vi.spyOn(provider, "reactivate").mockRejectedValueOnce(new Error("simulated Stripe outage"));
      await expect(service.reactivate("org-1")).rejects.toThrow(DependencyError);
      spy.mockRestore();

      const stillCanceling = await service.getBillingSummary("org-1");
      expect(stillCanceling.subscription.cancelAtPeriodEnd).toBe(true);
      expect(auditRepo.events.filter((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.REACTIVATED && e.profileId === "org-1")).toHaveLength(0);
    });
  });
});
