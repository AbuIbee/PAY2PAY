import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { ForbiddenError } from "@/lib/errors";
import { InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { InMemoryBusinessProfileRepository } from "@/lib/profiles/testFakes";
import { SandboxPlatformBillingProvider } from "@/test-support/organizations/sandboxPlatformBillingProvider";
import type { PlatformBillingWebhookEventRecord, PlatformBillingWebhookEventRepository } from "./platformBillingWebhookEventRepository";
import { InMemorySubscriptionInvoiceRepository, InMemorySubscriptionPaymentMethodRepository } from "./platformBillingTestFakes";
import { PLATFORM_BILLING_AUDIT_ACTION } from "./platformBillingService";
import { PlatformBillingWebhookService } from "./platformBillingWebhookService";

class InMemoryPlatformBillingWebhookEventRepository implements PlatformBillingWebhookEventRepository {
  private byKey = new Map<string, PlatformBillingWebhookEventRecord & { claimedAt: Date | null }>();

  /** Mirrors DrizzlePlatformBillingWebhookEventRepository.claimEvent's own atomic-upsert semantics. */
  async claimEvent(input: { provider: string; providerEventId: string; eventType: string; signatureVerified: boolean; payload: unknown; staleClaimMs: number }): Promise<PlatformBillingWebhookEventRecord | null> {
    const key = `${input.provider}:${input.providerEventId}`;
    const now = new Date();
    const existing = this.byKey.get(key);
    if (existing) {
      const claimIsFresh = existing.claimedAt && now.getTime() - existing.claimedAt.getTime() < input.staleClaimMs;
      if (existing.processedAt || claimIsFresh) return null;
      existing.claimedAt = now;
      return existing;
    }
    const record = { id: randomUUID(), provider: input.provider, providerEventId: input.providerEventId, eventType: input.eventType, signatureVerified: input.signatureVerified, payload: input.payload, receivedAt: now, processedAt: null, claimedAt: now };
    this.byKey.set(key, record);
    return record;
  }

  async markProcessed(id: string): Promise<void> {
    for (const record of this.byKey.values()) {
      if (record.id === id) record.processedAt = new Date();
    }
  }

  /** Test-only read accessor (not part of the production interface) — inspects what was actually persisted. */
  lookup(provider: string, providerEventId: string): PlatformBillingWebhookEventRecord | null {
    return this.byKey.get(`${provider}:${providerEventId}`) ?? null;
  }
}

describe("PlatformBillingWebhookService", () => {
  let provider: SandboxPlatformBillingProvider;
  let subscriptions: InMemorySubscriptionRepository;
  let invoices: InMemorySubscriptionInvoiceRepository;
  let paymentMethods: InMemorySubscriptionPaymentMethodRepository;
  let events: InMemoryPlatformBillingWebhookEventRepository;
  let auditRepo: InMemoryAuditEventRepository;
  let businessProfiles: InMemoryBusinessProfileRepository;
  let service: PlatformBillingWebhookService;

  beforeEach(() => {
    provider = new SandboxPlatformBillingProvider("test-webhook-secret");
    subscriptions = new InMemorySubscriptionRepository();
    invoices = new InMemorySubscriptionInvoiceRepository();
    paymentMethods = new InMemorySubscriptionPaymentMethodRepository();
    events = new InMemoryPlatformBillingWebhookEventRepository();
    auditRepo = new InMemoryAuditEventRepository();
    businessProfiles = new InMemoryBusinessProfileRepository();
    service = new PlatformBillingWebhookService({ provider, events, subscriptions, invoices, paymentMethods, audit: new AuditService(auditRepo), businessProfiles });
  });

  /** Seeds a minimal business_profile row at the exact literal organization id the sandbox subscription tests already use — `activateOnboardingIfNeeded` requires a real profile to advance onboardingStep against. */
  function seedBusinessProfile(organizationId: string): void {
    businessProfiles.byId.set(organizationId, {
      id: organizationId,
      ownerUserId: "owner-" + organizationId,
      legalBusinessName: "Test LLC",
      displayName: "Test",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
      status: "active",
      currency: "USD",
      createdAt: new Date(),
      dbaName: null,
      industry: null,
      formationJurisdiction: null,
      businessEmail: null,
      website: null,
      representative: null,
      onboardingStep: "tier_selected",
    });
  }

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: provider.signWebhookPayload(rawBody) };
  }

  it("rejects a spoofed webhook signature", async () => {
    const { rawBody } = signedWebhook({ providerEventId: "evt_spoof", eventType: "invoice.paid", id: "in_1" });
    await expect(service.receiveWebhook({ rawBody, signatureHeader: "0".repeat(64) })).rejects.toThrow(ForbiddenError);
  });

  it("syncs customer.subscription.updated into the local billing period — idempotent on exact redelivery", async () => {
    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: "plan-1" });
    await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_1", providerSubscriptionReference: "sandbox_sub_1" });

    const delivery = signedWebhook({
      providerEventId: "evt_1",
      eventType: "customer.subscription.updated",
      id: "sandbox_sub_1",
      current_period_start: 1700000000,
      current_period_end: 1702592000,
    });
    const first = await service.receiveWebhook(delivery);
    expect(first.status).toBe("processed");
    const updated = await subscriptions.findById(sub.id);
    expect(updated?.currentPeriodStart?.getTime()).toBe(1700000000 * 1000);

    const second = await service.receiveWebhook(delivery);
    expect(second.status).toBe("duplicate");
  });

  it("customer.subscription.deleted cancels the local subscription", async () => {
    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: "plan-1" });
    await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_1", providerSubscriptionReference: "sandbox_sub_del" });

    const result = await service.receiveWebhook(signedWebhook({ providerEventId: "evt_del", eventType: "customer.subscription.deleted", id: "sandbox_sub_del" }));
    expect(result.status).toBe("processed");
    const updated = await subscriptions.findById(sub.id);
    expect(updated?.status).toBe("canceled");
  });

  it("invoice.paid creates and marks an invoice paid when it did not exist locally yet — never fabricates 'paid' for an invoice the provider did not confirm", async () => {
    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: "plan-1" });
    await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_1", providerSubscriptionReference: "sandbox_sub_inv" });

    const result = await service.receiveWebhook(
      signedWebhook({ providerEventId: "evt_inv_paid", eventType: "invoice.paid", id: "in_new", subscription: "sandbox_sub_inv", amount_paid: 19900, amount_due: 19900 }),
    );
    expect(result.status).toBe("processed");
    const invoice = await invoices.findByProviderInvoiceReference("in_new");
    expect(invoice?.status).toBe("paid");
    expect(invoice?.amountPaidMinorUnits).toBe(19900);
  });

  it("invoice.payment_failed creates a past_due invoice locally — never 'paid'", async () => {
    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: "plan-1" });
    await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_1", providerSubscriptionReference: "sandbox_sub_fail" });

    const result = await service.receiveWebhook(
      signedWebhook({ providerEventId: "evt_inv_failed", eventType: "invoice.payment_failed", id: "in_failed", subscription: "sandbox_sub_fail", amount_due: 19900 }),
    );
    expect(result.status).toBe("processed");
    const invoice = await invoices.findByProviderInvoiceReference("in_failed");
    expect(invoice?.status).toBe("past_due");
  });

  it("a cross-tenant-impossible lookup (unrecognized subscription reference) is ignored, not applied against the wrong organization", async () => {
    const result = await service.receiveWebhook(
      signedWebhook({ providerEventId: "evt_unknown", eventType: "invoice.paid", id: "in_x", subscription: "sandbox_sub_never_existed", amount_paid: 100 }),
    );
    expect(result.status).toBe("ignored");
  });

  it("an unmapped event type is ignored, not thrown", async () => {
    const result = await service.receiveWebhook(signedWebhook({ providerEventId: "evt_other", eventType: "payment_method.attached", id: "pm_1" }));
    expect(result.status).toBe("ignored");
  });

  describe("checkout.session.completed (Section 7/9/10: the ONLY trusted confirmation of a hosted checkout)", () => {
    it("activates the subscription, attaches the real payment method, and records an audit event — resolved via the trusted provider customer reference, never a payload-supplied organization id", async () => {
      seedBusinessProfile("org-1");
      const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-1", pricingPlanId: "plan-1" });
      await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_checkout_1", providerSubscriptionReference: null });

      const session = await provider.createCheckoutSession({ providerCustomerReference: "sandbox_cust_checkout_1", planCode: "paid2you_business_core", successUrl: "https://app.test/success", cancelUrl: "https://app.test/cancel" });
      const { providerSubscriptionReference } = provider.simulateCheckoutCompleted(session.providerSessionReference);

      const result = await service.receiveWebhook(
        signedWebhook({ providerEventId: "evt_checkout_1", eventType: "checkout.session.completed", id: session.providerSessionReference, customer: "sandbox_cust_checkout_1", subscription: providerSubscriptionReference }),
      );
      expect(result.status).toBe("processed");

      const updated = await subscriptions.findById(sub.id);
      expect(updated?.providerSubscriptionReference).toBe(providerSubscriptionReference);
      expect(updated?.currentPeriodEnd).not.toBeNull();
      const pm = await paymentMethods.findActiveForOrganization("org-1");
      expect(pm?.displayLast4).toBe("4242");

      expect(auditRepo.events.some((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_ACTIVATED && e.profileId === "org-1")).toBe(true);
    });

    it("redelivery of the exact same completed-checkout event is a no-op (duplicate), never a second payment method/audit event", async () => {
      seedBusinessProfile("org-2");
      const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-2", pricingPlanId: "plan-1" });
      await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_checkout_2", providerSubscriptionReference: null });

      const session = await provider.createCheckoutSession({ providerCustomerReference: "sandbox_cust_checkout_2", planCode: "paid2you_business_core", successUrl: "https://app.test/success", cancelUrl: "https://app.test/cancel" });
      const { providerSubscriptionReference } = provider.simulateCheckoutCompleted(session.providerSessionReference);
      const delivery = signedWebhook({ providerEventId: "evt_checkout_2", eventType: "checkout.session.completed", id: session.providerSessionReference, customer: "sandbox_cust_checkout_2", subscription: providerSubscriptionReference });

      const first = await service.receiveWebhook(delivery);
      expect(first.status).toBe("processed");
      const second = await service.receiveWebhook(delivery);
      expect(second.status).toBe("duplicate");

      expect(auditRepo.events.filter((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_ACTIVATED && e.profileId === "org-2")).toHaveLength(1);
    });

    it("an unresolvable customer reference (no matching local subscription) is ignored, never applied against the wrong organization", async () => {
      const result = await service.receiveWebhook(
        signedWebhook({ providerEventId: "evt_checkout_unknown", eventType: "checkout.session.completed", id: "sess_x", customer: "sandbox_cust_never_existed", subscription: "sandbox_sub_x" }),
      );
      expect(result.status).toBe("ignored");
    });
  });

  it("invoice.payment_failed records a PAYMENT_FAILED audit event", async () => {
    const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-pf", pricingPlanId: "plan-1" });
    await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_pf", providerSubscriptionReference: "sandbox_sub_pf" });

    await service.receiveWebhook(signedWebhook({ providerEventId: "evt_pf_1", eventType: "invoice.payment_failed", id: "in_pf_1", subscription: "sandbox_sub_pf", amount_due: 19900 }));
    expect(auditRepo.events.some((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.PAYMENT_FAILED && e.profileId === "org-pf")).toBe(true);
  });

  describe("P0-3 (Codex): a failed processing attempt remains retryable, never permanently suppressed", () => {
    it("first delivery fails after the event is claimed (processedAt stays null); redelivery of the SAME event then succeeds and processes exactly once; a third delivery is a genuine duplicate", async () => {
      const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-retry-1", pricingPlanId: "plan-1" });
      await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_retry", providerSubscriptionReference: "sandbox_sub_retry" });

      let callCount = 0;
      const originalInsert = invoices.insert.bind(invoices);
      const spy = vi.spyOn(invoices, "insert").mockImplementation(async (input) => {
        callCount += 1;
        if (callCount === 1) throw new Error("simulated transient persistence failure");
        return originalInsert(input);
      });

      const delivery = signedWebhook({ providerEventId: "evt_retry_1", eventType: "invoice.paid", id: "in_retry_1", subscription: "sandbox_sub_retry", amount_paid: 19900, amount_due: 19900 });

      await expect(service.receiveWebhook(delivery)).rejects.toThrow("simulated transient persistence failure");
      expect(events.lookup("sandbox_platform_billing_mock", "evt_retry_1")?.processedAt).toBeNull();

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3 * 60 * 1000);
      const second = await service.receiveWebhook(delivery);
      vi.useRealTimers();
      expect(second.status).toBe("processed");
      expect(events.lookup("sandbox_platform_billing_mock", "evt_retry_1")?.processedAt).not.toBeNull();
      const invoice = await invoices.findByProviderInvoiceReference("in_retry_1");
      expect(invoice?.status).toBe("paid");

      const third = await service.receiveWebhook(delivery);
      expect(third.status).toBe("duplicate");

      spy.mockRestore();
    });

    it("concurrent duplicate deliveries of the SAME unprocessed event apply the business transition exactly once", async () => {
      const sub = await subscriptions.insert({ profileKind: "business", profileId: "org-concurrent-1", pricingPlanId: "plan-1" });
      await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: "sandbox_cust_concurrent", providerSubscriptionReference: "sandbox_sub_concurrent" });
      const delivery = signedWebhook({ providerEventId: "evt_concurrent_1", eventType: "invoice.paid", id: "in_concurrent_1", subscription: "sandbox_sub_concurrent", amount_paid: 19900, amount_due: 19900 });

      const [a, b] = await Promise.all([service.receiveWebhook(delivery), service.receiveWebhook(delivery)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(["duplicate", "processed"]);
      const invoice = await invoices.findByProviderInvoiceReference("in_concurrent_1");
      expect(invoice?.status).toBe("paid");
    });
  });

  describe("P0-4 (Codex): checkout.session.completed proves the hosted flow completed, NEVER activation eligibility on its own", () => {
    async function seedOrgWithCheckoutSession(organizationId: string, customerRef: string) {
      seedBusinessProfile(organizationId);
      const sub = await subscriptions.insert({ profileKind: "business", profileId: organizationId, pricingPlanId: "plan-1" });
      await subscriptions.setProviderReferences(sub.id, { providerCustomerReference: customerRef, providerSubscriptionReference: null });
      const session = await provider.createCheckoutSession({ providerCustomerReference: customerRef, planCode: "paid2you_business_core", successUrl: "https://app.test/success", cancelUrl: "https://app.test/cancel" });
      const { providerSubscriptionReference } = provider.simulateCheckoutCompleted(session.providerSessionReference);
      return { sub, session, providerSubscriptionReference };
    }

    it("Stripe status 'active' at checkout completion → eligible: onboarding advances, SUBSCRIPTION_ACTIVATED audited", async () => {
      const { session, providerSubscriptionReference } = await seedOrgWithCheckoutSession("org-p04-active", "sandbox_cust_p04_active");
      // provider.simulateCheckoutCompleted already leaves the subscription at status "active" by default.
      const result = await service.receiveWebhook(signedWebhook({ providerEventId: "evt_p04_active", eventType: "checkout.session.completed", id: session.providerSessionReference, customer: "sandbox_cust_p04_active", subscription: providerSubscriptionReference }));
      expect(result.status).toBe("processed");
      expect(businessProfiles.byId.get("org-p04-active")?.onboardingStep).toBe("billing_setup_complete");
      expect(auditRepo.events.some((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_ACTIVATED && e.profileId === "org-p04-active")).toBe(true);
    });

    it.each([
      ["canceled", "canceled"],
      ["payment_failed (covers incomplete/incomplete_expired/unpaid, which all map here)", "payment_failed"],
      ["past_due", "past_due"],
      ["suspended (covers paused)", "suspended"],
      // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-4 (Codex re-verification): Paid2You
      // has no approved Stripe trial product — 'trialing' must deny activation exactly like every
      // other non-active status, through the real production checkout-completion path.
      ["trialing (no approved Paid2You trial product exists)", "trialing"],
    ] as const)("Stripe status '%s' at checkout completion → NOT eligible: onboarding does NOT advance, NO SUBSCRIPTION_ACTIVATED audit, provider references still synced for a later retry", async (_label, status) => {
      const organizationId = `org-p04-${status}`;
      const customerRef = `sandbox_cust_p04_${status}`;
      const { session, providerSubscriptionReference } = await seedOrgWithCheckoutSession(organizationId, customerRef);
      provider.simulateSubscriptionStatus(providerSubscriptionReference, status);

      const result = await service.receiveWebhook(signedWebhook({ providerEventId: `evt_p04_${status}`, eventType: "checkout.session.completed", id: session.providerSessionReference, customer: customerRef, subscription: providerSubscriptionReference }));
      expect(result.status).toBe("processed"); // the webhook delivery itself is still handled/claimed — never an error — only ACTIVATION is withheld.

      expect(businessProfiles.byId.get(organizationId)?.onboardingStep).not.toBe("billing_setup_complete");
      expect(auditRepo.events.some((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_ACTIVATED && e.profileId === organizationId)).toBe(false);

      // Still synced for correlation/an honest Billing page — never silently dropped.
      const updatedSub = await subscriptions.findById((await subscriptions.findActiveByProfile("business", organizationId))!.id);
      expect(updatedSub?.providerSubscriptionReference).toBe(providerSubscriptionReference);
    });

    it("a later customer.subscription.updated reporting genuine 'active' status activates an organization left pending by an earlier non-eligible checkout completion", async () => {
      const organizationId = "org-p04-later-activation";
      const customerRef = "sandbox_cust_p04_later";
      const { session, providerSubscriptionReference } = await seedOrgWithCheckoutSession(organizationId, customerRef);
      provider.simulateSubscriptionStatus(providerSubscriptionReference, "payment_failed");
      await service.receiveWebhook(signedWebhook({ providerEventId: "evt_p04_later_1", eventType: "checkout.session.completed", id: session.providerSessionReference, customer: customerRef, subscription: providerSubscriptionReference }));
      expect(businessProfiles.byId.get(organizationId)?.onboardingStep).not.toBe("billing_setup_complete");

      // The subscription later genuinely becomes active (e.g. a delayed payment confirmation).
      provider.simulateSubscriptionStatus(providerSubscriptionReference, "active");
      const result = await service.receiveWebhook(signedWebhook({ providerEventId: "evt_p04_later_2", eventType: "customer.subscription.updated", id: providerSubscriptionReference, current_period_start: 1700000000, current_period_end: 1702592000 }));
      expect(result.status).toBe("processed");
      expect(businessProfiles.byId.get(organizationId)?.onboardingStep).toBe("billing_setup_complete");
      expect(auditRepo.events.filter((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_ACTIVATED && e.profileId === organizationId)).toHaveLength(1);
    });

    // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-4 (Codex re-verification): the
    // SECOND activation entry point — `customer.subscription.updated`/`.created` via
    // `syncSubscriptionPeriod` — must deny activation for 'trialing' exactly like `syncCheckoutCompleted`
    // does. Exercises the real production path: provider.simulateSubscriptionStatus → retrieveSubscriptionState → the same `state.status === "active"` gate.
    it("P0-4: customer.subscription.updated reporting 'trialing' does NOT activate — no approved Paid2You trial product exists", async () => {
      const organizationId = "org-p04-trialing-period-sync";
      const customerRef = "sandbox_cust_p04_trialing_period";
      const { session, providerSubscriptionReference } = await seedOrgWithCheckoutSession(organizationId, customerRef);
      // First sync provider references via a non-eligible checkout completion (mirrors the "later
      // activation" test above) — syncCheckoutCompleted syncs references unconditionally regardless
      // of eligibility, so the local row can resolve this subscription reference for the period-sync
      // event below without ever activating through the checkout path itself.
      provider.simulateSubscriptionStatus(providerSubscriptionReference, "payment_failed");
      await service.receiveWebhook(signedWebhook({ providerEventId: "evt_p04_trialing_period_setup", eventType: "checkout.session.completed", id: session.providerSessionReference, customer: customerRef, subscription: providerSubscriptionReference }));
      expect(businessProfiles.byId.get(organizationId)?.onboardingStep).not.toBe("billing_setup_complete");

      provider.simulateSubscriptionStatus(providerSubscriptionReference, "trialing");
      const result = await service.receiveWebhook(signedWebhook({ providerEventId: "evt_p04_trialing_period", eventType: "customer.subscription.updated", id: providerSubscriptionReference, current_period_start: 1700000000, current_period_end: 1702592000 }));
      expect(result.status).toBe("processed");
      expect(businessProfiles.byId.get(organizationId)?.onboardingStep).not.toBe("billing_setup_complete");
      expect(auditRepo.events.some((e) => e.action === PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_ACTIVATED && e.profileId === organizationId)).toBe(false);
    });
  });
});
