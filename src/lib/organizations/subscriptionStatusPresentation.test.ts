import { describe, expect, it } from "vitest";
import { deriveSubscriptionDisplayStatus } from "./subscriptionStatusPresentation";

describe("deriveSubscriptionDisplayStatus (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 16)", () => {
  it("NOT_SUBSCRIBED when no subscription exists", () => {
    expect(deriveSubscriptionDisplayStatus({ organizationStatus: "active", subscription: null, hasPastDueInvoice: false })).toBe("NOT_SUBSCRIBED");
  });

  it("ACTIVE for an ordinary active subscription with no past-due invoice and no pending cancellation", () => {
    expect(
      deriveSubscriptionDisplayStatus({ organizationStatus: "active", subscription: { status: "active", cancelAtPeriodEnd: false }, hasPastDueInvoice: false }),
    ).toBe("ACTIVE");
  });

  it("PAST_DUE when an active subscription has a past-due invoice", () => {
    expect(
      deriveSubscriptionDisplayStatus({ organizationStatus: "active", subscription: { status: "active", cancelAtPeriodEnd: false }, hasPastDueInvoice: true }),
    ).toBe("PAST_DUE");
  });

  it("CANCEL_AT_PERIOD_END takes priority over PAST_DUE", () => {
    expect(
      deriveSubscriptionDisplayStatus({ organizationStatus: "active", subscription: { status: "active", cancelAtPeriodEnd: true }, hasPastDueInvoice: true }),
    ).toBe("CANCEL_AT_PERIOD_END");
  });

  it("CANCELED once the subscription's own status is canceled, regardless of cancelAtPeriodEnd", () => {
    expect(
      deriveSubscriptionDisplayStatus({ organizationStatus: "active", subscription: { status: "canceled", cancelAtPeriodEnd: true }, hasPastDueInvoice: false }),
    ).toBe("CANCELED");
  });

  it("SUSPENDED when the organization itself is disabled, regardless of subscription state — Owner minimum recovery access is a separate, already-existing concern", () => {
    expect(
      deriveSubscriptionDisplayStatus({ organizationStatus: "disabled", subscription: { status: "active", cancelAtPeriodEnd: false }, hasPastDueInvoice: false }),
    ).toBe("SUSPENDED");
  });
});
