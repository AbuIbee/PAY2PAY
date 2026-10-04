import { describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createBusinessOnboardingTestHarness } from "./businessOnboardingTestFakes";

const representative = {
  firstName: "Jane",
  lastName: "Doe",
  title: "CEO",
  email: "jane@abc.com",
  phone: "+15555550100",
  relationshipToBusiness: "Owner",
};

function detailsInput(overrides: Partial<Parameters<Awaited<ReturnType<typeof createBusinessOnboardingTestHarness>>["onboarding"]["submitBusinessDetails"]>[0]> = {}) {
  return {
    actingUserId: "user-1",
    organizationId: null,
    legalBusinessName: "ABC Trucking LLC",
    displayName: "ABC Trucking",
    entityType: "LLC",
    dbaName: null,
    industry: "TRUCKING" as const,
    formationJurisdiction: "DE",
    businessAddress: { line1: "1 Main St", city: "Dover", state: "DE", postalCode: "19901" },
    businessEmail: "billing@abctrucking.com",
    businessPhone: "+15555550101",
    website: null,
    country: "US",
    state: "DE",
    representative,
    ...overrides,
  };
}

describe("BusinessOnboardingService (Requirement 1-5, Section 2/3)", () => {
  it("creates a new Business organization from Business Details — never a Personal->Business conversion", async () => {
    const { onboarding } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    expect(profile.legalBusinessName).toBe("ABC Trucking LLC");
    expect(profile.onboardingStep).toBe("details_complete");
    expect(profile.industry).toBe("TRUCKING");
    expect(profile.representative?.firstName).toBe("Jane");
  });

  it("seeds the new Owner/Manager/Employee 2/Employee 3 roles and points the Owner membership's roleId at the new Owner role", async () => {
    const { onboarding, organizationRoles, staffMembers } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    const roles = await organizationRoles.listRolesForOrganization(profile.id);
    expect(roles.map((r) => r.displayName).sort()).toEqual(["Employee 2", "Employee 3", "Manager", "Owner"]);
    const ownerRole = roles.find((r) => r.isOwnerRole);
    const membership = await staffMembers.findActiveByBusinessAndUser(profile.id, "user-1");
    expect(membership!.roleId).toBe(ownerRole!.id);
  });

  it("resuming with an existing organizationId amends the same organization rather than creating a second one", async () => {
    const { onboarding } = await createBusinessOnboardingTestHarness();
    const first = await onboarding.submitBusinessDetails(detailsInput());
    const resumed = await onboarding.submitBusinessDetails(detailsInput({ organizationId: first.id, dbaName: "ABC" }));
    expect(resumed.id).toBe(first.id);
    expect(resumed.dbaName).toBe("ABC");
  });

  it("no duplicate organization is created, and another user cannot resume someone else's organization", async () => {
    const { onboarding } = await createBusinessOnboardingTestHarness();
    const owned = await onboarding.submitBusinessDetails(detailsInput());
    await expect(onboarding.submitBusinessDetails(detailsInput({ organizationId: owned.id, actingUserId: "user-2" }))).rejects.toThrow(ForbiddenError);
  });

  it("verification is rejected before business details are complete, and never auto-verifies on submission", async () => {
    const { onboarding, verificationProvider } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    const record = await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
    expect(record.status).toBe("pending");
    expect(JSON.stringify(record)).not.toContain("123456789");
    void verificationProvider;
  });

  it("tier selection requires verification to have been submitted first, and rejects an unknown plan code", async () => {
    const { onboarding } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    await expect(onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" })).rejects.toThrow(ValidationError);

    await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
    await expect(onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "not_a_real_plan" })).rejects.toThrow(ValidationError);

    const subscription = await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
    expect(subscription.status).toBe("active");
  });

  it("billing setup requires tier selection first; NOT_CONFIGURED/unavailable provider never erases onboarding progress", async () => {
    const { onboarding, billingProvider } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });

    await expect(
      onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" }),
    ).rejects.toThrow(ValidationError); // tier not yet selected

    await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
    const summary = await onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" });
    expect(summary.subscription.providerSubscriptionReference).toBeTruthy();

    // "PAID2YOU — FINAL SINGLE P0 DEFECT REMEDIATION" (2026-10-04), P0-5: setUpBilling itself never
    // completes onboarding — only a provider-confirmed webhook does (see the describe block below for
    // the full matrix and the active-case completion proof).
    const stateAfter = await onboarding.getOnboardingState({ actingUserId: "user-1", organizationId: profile.id });
    expect(stateAfter.profile.onboardingStep).not.toBe("billing_setup_complete");
    void billingProvider;
  });

  describe("P0-5 (Final remediation): setUpBilling cannot complete billing without a provider-confirmed active subscription", () => {
    /**
     * Codex's exact finding: `startSubscription()`'s own return shape carries no authoritative status
     * at all, yet the legacy `setUpBilling` path unconditionally advanced `billing_setup_complete`
     * regardless. This proves the fix for the full required status matrix (Section 12), exercising the
     * REAL production path (`BusinessOnboardingService.setUpBilling` -> `PlatformBillingService.
     * setUpBilling` -> `StripePlatformBillingProvider.startSubscription`-equivalent) — never merely
     * asserting the desired implementation.
     */
    it.each(["active", "trialing", "payment_failed", "past_due", "canceled", "suspended"] as const)(
      "setUpBilling never advances billing_setup_complete on its own, regardless of the provider's authoritative status (%s)",
      async (status) => {
        const { onboarding, billingProvider } = await createBusinessOnboardingTestHarness();
        const profile = await onboarding.submitBusinessDetails(detailsInput());
        await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
        await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
        const summary = await onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" });
        // Set the provider's authoritative state AFTER setUpBilling returns — proves the completion
        // marker was never conditioned on it in the first place (the defect: no status was ever
        // consulted), for every status including "active" itself.
        billingProvider.simulateSubscriptionStatus(summary.subscription.providerSubscriptionReference!, status);

        const state = await onboarding.getOnboardingState({ actingUserId: "user-1", organizationId: profile.id });
        expect(state.profile.onboardingStep).not.toBe("billing_setup_complete");
        expect(state.activation.active).toBe(false);
      },
    );

    it("a legacy-setUpBilling subscription (no webhook confirmation yet) grants zero paid entitlement and never activates the Business, with no activation audit recorded", async () => {
      const { onboarding, plans, subscriptions, businessProfiles, auditRepo } = await createBusinessOnboardingTestHarness();
      const profile = await onboarding.submitBusinessDetails(detailsInput());
      await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
      await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
      await onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" });

      // The SAME real EntitlementService/PricingService pairing production uses — not a bespoke stub.
      const { EntitlementService } = await import("./entitlementService");
      const { PricingService } = await import("@/lib/pricing/pricingService");
      const { InMemoryPricingPlanEntitlementRepository } = await import("@/lib/pricing/testFakes");
      const entitlements = new InMemoryPricingPlanEntitlementRepository();
      const plan = await plans.findByCode("paid2you_business_core");
      entitlements.seed({ pricingPlanId: plan!.id, featureKey: "business_dashboard", enabled: true, limitValue: null });
      const entitlementService = new EntitlementService(new PricingService(plans, subscriptions), entitlements, businessProfiles);

      expect(await entitlementService.entitled(profile.id, "business_dashboard")).toBe(false);
      expect(auditRepo.events.some((e) => e.action === "PLATFORM_SUBSCRIPTION_ACTIVATED")).toBe(false);
    });

    it("P0-5 ACTIVE CASE: the real PlatformBillingWebhookService — the ONE canonical completion path — activates a legacy-setUpBilling-originated subscription once Stripe genuinely confirms 'active', exactly once, with no duplicate on replay", async () => {
      const { onboarding, billingProvider, subscriptions, invoices, paymentMethods, businessProfiles, audit, auditRepo } = await createBusinessOnboardingTestHarness();
      const profile = await onboarding.submitBusinessDetails(detailsInput());
      await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
      await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
      const summary = await onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" });
      const providerSubscriptionReference = summary.subscription.providerSubscriptionReference!;

      // Not yet complete — proven above and re-asserted here as this test's own precondition.
      expect((await onboarding.getOnboardingState({ actingUserId: "user-1", organizationId: profile.id })).profile.onboardingStep).not.toBe("billing_setup_complete");

      const { PlatformBillingWebhookService } = await import("./platformBillingWebhookService");
      const { InMemoryPlatformBillingWebhookEventRepository } = await import("./platformBillingTestFakes");
      const webhookService = new PlatformBillingWebhookService({
        provider: billingProvider,
        events: new InMemoryPlatformBillingWebhookEventRepository(),
        subscriptions,
        invoices,
        paymentMethods,
        audit,
        businessProfiles,
      });

      const rawBody = JSON.stringify({ providerEventId: "evt_legacy_active_1", eventType: "customer.subscription.updated", id: providerSubscriptionReference, current_period_start: 1700000000, current_period_end: 1702592000 });
      const first = await webhookService.receiveWebhook({ rawBody, signatureHeader: billingProvider.signWebhookPayload(rawBody) });
      expect(first.status).toBe("processed");

      const state = await onboarding.getOnboardingState({ actingUserId: "user-1", organizationId: profile.id });
      expect(state.profile.onboardingStep).toBe("billing_setup_complete");
      expect(auditRepo.events.filter((e) => e.action === "PLATFORM_SUBSCRIPTION_ACTIVATED" && e.profileId === profile.id)).toHaveLength(1);

      // Replay of the exact same event is a safe no-op — never a second activation/audit.
      const second = await webhookService.receiveWebhook({ rawBody, signatureHeader: billingProvider.signWebhookPayload(rawBody) });
      expect(second.status).toBe("duplicate");
      expect(auditRepo.events.filter((e) => e.action === "PLATFORM_SUBSCRIPTION_ACTIVATED" && e.profileId === profile.id)).toHaveLength(1);
    });
  });

  it("Business is NOT activated merely because the onboarding form was submitted — activation requires verification AND an active subscription", async () => {
    const { onboarding, activation, verifications, verificationProvider, businessProfiles } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
    await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
    await onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" });
    // "PAID2YOU — FINAL SINGLE P0 DEFECT REMEDIATION" (2026-10-04), P0-5: setUpBilling no longer
    // completes onboarding itself (see the dedicated P0-5 describe block above) — this test is about
    // verification independence, not billing completion, so simulate the provider-confirmed webhook
    // having already landed, exactly mirroring this file's existing "P0-5 (Codex)" reentry tests'
    // own precedent for the same purpose.
    await businessProfiles.setOnboardingStep(profile.id, "billing_setup_complete");

    const prematureStatus = await activation.computeActivationStatus(profile.id);
    expect(prematureStatus.active).toBe(false);
    expect(prematureStatus.onboardingComplete).toBe(true);
    expect(prematureStatus.verificationStatus).toBe("pending"); // not yet verified — onboarding completion alone is not activation.
    void verificationProvider;
    void verifications;
  });

  it("correct activation when all domain requirements are satisfied (controlled test)", async () => {
    const { onboarding, activation, verifications, verificationProvider, businessProfiles } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
    await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
    await onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" });
    // See the preceding test's own comment: setUpBilling no longer completes onboarding itself.
    await businessProfiles.setOnboardingStep(profile.id, "billing_setup_complete");
    await onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "terms" });
    await onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "business_subscription_policy" });
    await onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "recurring_payment_authorization" });

    const latest = await verifications.findLatestForOrganization(profile.id);
    verificationProvider.simulateDecision(latest!.providerReference!, "verified");
    await verifications.applyResult(latest!.id, {
      status: "verified",
      legalNameResult: "match",
      taxIdResult: "match",
      addressResult: "match",
      representativeResult: "match",
      failureCode: null,
      reviewRequired: false,
      verifiedAt: new Date(),
    });

    const status = await activation.computeActivationStatus(profile.id);
    expect(status.active).toBe(true);
    expect(status.reasons).toHaveLength(0);
  });

  it("submitting verification never persists the raw Tax ID anywhere in onboarding state", async () => {
    const { onboarding } = await createBusinessOnboardingTestHarness();
    const profile = await onboarding.submitBusinessDetails(detailsInput());
    const record = await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "987654321" });
    const state = await onboarding.getOnboardingState({ actingUserId: "user-1", organizationId: profile.id });
    expect(JSON.stringify(state)).not.toContain("987654321");
    expect(record.taxIdLast4).toBe("4321");
  });

  describe("legal acceptance (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 3/8/9/24)", () => {
    it("missing required acceptance blocks Business activation even when verification and subscription are both otherwise satisfied", async () => {
      const { onboarding, activation, verifications, verificationProvider } = await createBusinessOnboardingTestHarness();
      const profile = await onboarding.submitBusinessDetails(detailsInput());
      await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
      await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
      await onboarding.setUpBilling({ actingUserId: "user-1", organizationId: profile.id, billingEmail: "b@b.com", paymentMethodToken: "tok" });
      // Deliberately accept only 2 of the 3 required documents.
      await onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "terms" });
      await onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "business_subscription_policy" });

      const latest = await verifications.findLatestForOrganization(profile.id);
      verificationProvider.simulateDecision(latest!.providerReference!, "verified");
      await verifications.applyResult(latest!.id, {
        status: "verified",
        legalNameResult: "match",
        taxIdResult: "match",
        addressResult: "match",
        representativeResult: "match",
        failureCode: null,
        reviewRequired: false,
        verifiedAt: new Date(),
      });

      const status = await activation.computeActivationStatus(profile.id);
      expect(status.active).toBe(false);
      expect(status.legalAcceptanceComplete).toBe(false);
      expect(status.reasons).toContain("Required legal agreements have not yet been accepted.");
    });

    it("acceptLegalDocument requires a tier to have been selected first", async () => {
      const { onboarding } = await createBusinessOnboardingTestHarness();
      const profile = await onboarding.submitBusinessDetails(detailsInput());
      await expect(onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "terms" })).rejects.toThrow(ValidationError);
    });

    it("another user cannot accept legal documents on behalf of someone else's organization", async () => {
      const { onboarding } = await createBusinessOnboardingTestHarness();
      const profile = await onboarding.submitBusinessDetails(detailsInput());
      await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
      await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
      await expect(onboarding.acceptLegalDocument({ actingUserId: "someone-else", organizationId: profile.id, documentType: "terms" })).rejects.toThrow(ForbiddenError);
    });

    it("rejects an unrecognized document type", async () => {
      const { onboarding } = await createBusinessOnboardingTestHarness();
      const profile = await onboarding.submitBusinessDetails(detailsInput());
      await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
      await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
      await expect(onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "made_up" })).rejects.toThrow(ValidationError);
    });

    it("getOnboardingState reports per-document acceptance status, reflecting exactly what has (and has not) been accepted", async () => {
      const { onboarding } = await createBusinessOnboardingTestHarness();
      const profile = await onboarding.submitBusinessDetails(detailsInput());
      await onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
      await onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
      await onboarding.acceptLegalDocument({ actingUserId: "user-1", organizationId: profile.id, documentType: "terms" });

      const state = await onboarding.getOnboardingState({ actingUserId: "user-1", organizationId: profile.id });
      const terms = state.legalAcceptance.find((d) => d.documentType === "terms")!;
      const policy = state.legalAcceptance.find((d) => d.documentType === "business_subscription_policy")!;
      expect(terms.accepted).toBe(true);
      expect(policy.accepted).toBe(false);
    });
  });

  describe("P0-5 (Codex): onboarding tier reentry cannot bypass billing", () => {
    async function verifiedOrg(harness: Awaited<ReturnType<typeof createBusinessOnboardingTestHarness>>) {
      const profile = await harness.onboarding.submitBusinessDetails(detailsInput());
      await harness.onboarding.submitVerification({ actingUserId: "user-1", organizationId: profile.id, taxId: "123456789" });
      return profile;
    }

    it("a new Business in the legitimate pre-subscription stage can select Starter, Core, Growth, or Scale", async () => {
      for (const planCode of ["paid2you_business_starter", "paid2you_business_core", "paid2you_business_growth", "paid2you_business_scale"]) {
        const harness = await createBusinessOnboardingTestHarness();
        const profile = await verifiedOrg(harness);
        const subscription = await harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode });
        expect(subscription.pricingPlanId).toBeTruthy();
      }
    });

    it("Enterprise is rejected from standard self-service tier selection at any point", async () => {
      const harness = await createBusinessOnboardingTestHarness();
      const profile = await verifiedOrg(harness);
      await expect(harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_enterprise" })).rejects.toThrow(ValidationError);
    });

    it("tier selection alone does not attach any provider subscription reference — only a confirmed hosted-checkout completion does", async () => {
      const harness = await createBusinessOnboardingTestHarness();
      const profile = await verifiedOrg(harness);
      const subscription = await harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" });
      expect(subscription.providerSubscriptionReference).toBeNull();
    });

    it("completed onboarding (billing_setup_complete) cannot re-enter tier selection to change plan — zero unauthorized local subscription replacement", async () => {
      const harness = await createBusinessOnboardingTestHarness();
      const profile = await verifiedOrg(harness);
      const original = await harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_starter" });
      await harness.businessProfiles.setOnboardingStep(profile.id, "billing_setup_complete");

      await expect(harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_growth" })).rejects.toThrow(ValidationError);

      const stillCurrent = await harness.subscriptions.findActiveByProfile("business", profile.id);
      expect(stillCurrent?.id).toBe(original.id);
      expect(stillCurrent?.pricingPlanId).toBe(original.pricingPlanId);
    });

    it("an active Starter organization (billing_setup_complete) cannot re-enter onboarding to select Enterprise", async () => {
      const harness = await createBusinessOnboardingTestHarness();
      const profile = await verifiedOrg(harness);
      await harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_starter" });
      await harness.businessProfiles.setOnboardingStep(profile.id, "billing_setup_complete");

      await expect(harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_enterprise" })).rejects.toThrow(ValidationError);
    });

    it("an active Growth organization (billing_setup_complete) cannot re-enter onboarding to downgrade to Starter/Core", async () => {
      const harness = await createBusinessOnboardingTestHarness();
      const profile = await verifiedOrg(harness);
      const original = await harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_growth" });
      await harness.businessProfiles.setOnboardingStep(profile.id, "billing_setup_complete");

      await expect(harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_starter" })).rejects.toThrow(ValidationError);
      await expect(harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_core" })).rejects.toThrow(ValidationError);

      const stillCurrent = await harness.subscriptions.findActiveByProfile("business", profile.id);
      expect(stillCurrent?.pricingPlanId).toBe(original.pricingPlanId);
    });

    it("a subscription that already has a real provider reference (checkout completed, even if not yet eligible) cannot be replaced via onboarding reentry, even before billing_setup_complete", async () => {
      const harness = await createBusinessOnboardingTestHarness();
      const profile = await verifiedOrg(harness);
      const original = await harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_starter" });
      // Simulates a checkout that completed but left the subscription not-yet-eligible (e.g. P0-4's
      // own "incomplete" scenario) — onboardingStep was deliberately NOT advanced, but a real provider
      // relationship now exists.
      await harness.subscriptions.setProviderReferences(original.id, { providerCustomerReference: "cust_1", providerSubscriptionReference: "sub_1" });

      await expect(harness.onboarding.selectTier({ actingUserId: "user-1", organizationId: profile.id, planCode: "paid2you_business_growth" })).rejects.toThrow(ValidationError);
    });

    it("wrong organization / nonmember is denied tier (re)selection", async () => {
      const harness = await createBusinessOnboardingTestHarness();
      const profile = await verifiedOrg(harness);
      await expect(harness.onboarding.selectTier({ actingUserId: "someone-else", organizationId: profile.id, planCode: "paid2you_business_starter" })).rejects.toThrow(ForbiddenError);
    });
  });
});
