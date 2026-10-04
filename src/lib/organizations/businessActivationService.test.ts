import { describe, expect, it } from "vitest";
import { createBusinessOnboardingTestHarness } from "./businessOnboardingTestFakes";

const representative = {
  firstName: "Jo",
  lastName: "Doe",
  title: "CEO",
  email: "jo@acme.test",
  phone: "555-0100",
  relationshipToBusiness: "owner",
};

/**
 * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 4: no dedicated test file existed
 * for `BusinessActivationService` before this phase — this is the direct proof that "review_required"
 * (Middesk's own `in_review` state, mapped by `mapMiddeskStatus`) never satisfies the strict
 * `verificationStatus === "verified"` check `computeActivationStatus` requires.
 */
describe("BusinessActivationService — verification status gating", () => {
  async function setUpOrganizationThroughVerification() {
    const ctx = await createBusinessOnboardingTestHarness();
    const profile = await ctx.onboarding.submitBusinessDetails({
      actingUserId: "owner-1",
      organizationId: null,
      legalBusinessName: "Acme Freight LLC",
      displayName: "Acme Freight",
      entityType: "LLC",
      dbaName: null,
      industry: "TRUCKING",
      formationJurisdiction: "DE",
      businessAddress: { line1: "1 Main St", city: "Dover", state: "DE", postalCode: "19901" },
      businessEmail: "ops@acme.test",
      businessPhone: null,
      website: null,
      country: "US",
      state: "DE",
      representative,
    });
    const record = await ctx.onboarding.submitVerification({ actingUserId: "owner-1", organizationId: profile.id, taxId: "12-3456789" });
    return { ctx, profile, record };
  }

  it("not_submitted/pending never activates", async () => {
    const { ctx, profile } = await setUpOrganizationThroughVerification();
    const status = await ctx.activation.computeActivationStatus(profile.id);
    expect(status.verificationStatus).toBe("pending");
    expect(status.active).toBe(false);
  });

  it("review_required (Middesk's own in_review) never activates — even if every OTHER activation fact is independently true", async () => {
    const { ctx, profile, record } = await setUpOrganizationThroughVerification();
    ctx.verificationProvider.simulateDecision(record.providerReference!, "review_required");
    await ctx.verificationService.applyVerificationResult(record.providerReference!);

    const status = await ctx.activation.computeActivationStatus(profile.id);
    expect(status.verificationStatus).toBe("review_required");
    expect(status.active).toBe(false);
    expect(status.reasons).toContain("Business verification is not yet complete.");
  });

  it("rejected never activates", async () => {
    const { ctx, profile, record } = await setUpOrganizationThroughVerification();
    ctx.verificationProvider.simulateDecision(record.providerReference!, "rejected");
    await ctx.verificationService.applyVerificationResult(record.providerReference!);

    const status = await ctx.activation.computeActivationStatus(profile.id);
    expect(status.verificationStatus).toBe("rejected");
    expect(status.active).toBe(false);
  });

  it("verified is necessary but not sufficient on its own — still requires onboarding/subscription/legal acceptance", async () => {
    const { ctx, profile, record } = await setUpOrganizationThroughVerification();
    ctx.verificationProvider.simulateDecision(record.providerReference!, "verified");
    await ctx.verificationService.applyVerificationResult(record.providerReference!);

    const status = await ctx.activation.computeActivationStatus(profile.id);
    expect(status.verificationStatus).toBe("verified");
    // Onboarding has not reached billing_setup_complete, no subscription, no legal acceptance yet.
    expect(status.active).toBe(false);
  });
});
