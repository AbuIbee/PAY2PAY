import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { mapStripeInvoiceStatus, mapStripeSubscriptionStatus, StripePlatformBillingProvider } from "./stripePlatformBillingProvider";

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 58: contract tests for the real Stripe adapter — no
 * live Stripe account exists in this environment, so these exercise the parts that need no network
 * call: status mapping, plan->price resolution (including Enterprise's deliberate absence), and
 * webhook signature verification/parsing against the OFFICIAL Stripe SDK's own
 * `webhooks.generateTestHeaderString` helper (a real HMAC computation, not a hand-rolled one).
 */
describe("StripePlatformBillingProvider", () => {
  describe("mapStripeSubscriptionStatus", () => {
    it("maps every Stripe subscription status to the correct existing ProviderSubscriptionStatus, never fabricating 'active' for anything but genuinely active", () => {
      expect(mapStripeSubscriptionStatus("active")).toBe("active");
      expect(mapStripeSubscriptionStatus("past_due")).toBe("past_due");
      expect(mapStripeSubscriptionStatus("canceled")).toBe("canceled");
      expect(mapStripeSubscriptionStatus("paused")).toBe("suspended");
      expect(mapStripeSubscriptionStatus("unpaid")).toBe("payment_failed");
      expect(mapStripeSubscriptionStatus("incomplete")).toBe("payment_failed");
      expect(mapStripeSubscriptionStatus("incomplete_expired")).toBe("payment_failed");
    });

    // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-4 (Codex re-verification): Paid2You
    // has no approved Stripe trial product — a 'trialing' Stripe subscription must map to its own
    // distinct status, never the same "active" value that activates a Business.
    it("P0-4: maps 'trialing' to its own distinct status, never 'active' — Paid2You has no approved trial product", () => {
      const mapped = mapStripeSubscriptionStatus("trialing");
      expect(mapped).toBe("trialing");
      expect(mapped).not.toBe("active");
    });
  });

  describe("mapStripeInvoiceStatus", () => {
    it("maps every real Stripe invoice status, never fabricating 'paid'", () => {
      expect(mapStripeInvoiceStatus("paid")).toBe("paid");
      expect(mapStripeInvoiceStatus("open")).toBe("open");
      expect(mapStripeInvoiceStatus("void")).toBe("void");
      expect(mapStripeInvoiceStatus("uncollectible")).toBe("void");
      expect(mapStripeInvoiceStatus("draft")).toBe("open");
      expect(mapStripeInvoiceStatus(null)).toBe("open");
    });
  });

  describe("plan -> Stripe Price resolution", () => {
    function provider(priceIdByPlanCode: Record<string, string | undefined> = {}) {
      return new StripePlatformBillingProvider({ secretKey: "sk_test_fake", webhookSecret: "whsec_fake", priceIdByPlanCode });
    }

    it("throws ConfigurationError (never silently substitutes a different price) when a plan has no configured STRIPE_*_PRICE_ID", async () => {
      await expect(
        provider({}).startSubscription({ providerCustomerReference: "cus_1", providerPaymentMethodReference: "pm_1", planCode: "paid2you_business_starter" }),
      ).rejects.toThrow(/No Stripe Price ID is configured for plan "paid2you_business_starter"/);
    });

    it("Enterprise has structurally no price mapping path at all — confirms the self-service route's own rejection is backed by this adapter also having nothing to map it to", async () => {
      await expect(
        provider({ paid2you_business_starter: "price_abc" }).startSubscription({ providerCustomerReference: "cus_1", providerPaymentMethodReference: "pm_1", planCode: "paid2you_business_enterprise" }),
      ).rejects.toThrow(/No Stripe Price ID is configured for plan "paid2you_business_enterprise"/);
    });
  });

  describe("webhook signature verification (against the official Stripe SDK's own HMAC implementation)", () => {
    const webhookSecret = "whsec_test_secret_abc123";

    function provider() {
      return new StripePlatformBillingProvider({ secretKey: "sk_test_fake", webhookSecret, priceIdByPlanCode: {} });
    }

    it("accepts a genuinely valid Stripe-signed payload", () => {
      const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } });
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      expect(provider().verifyWebhookSignature(payload, header)).toBe(true);
    });

    it("rejects a payload signed with the wrong secret", () => {
      const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } });
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_totally_different" });
      expect(provider().verifyWebhookSignature(payload, header)).toBe(false);
    });

    it("rejects a tampered payload even with a header computed for the original", () => {
      const original = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } });
      const header = Stripe.webhooks.generateTestHeaderString({ payload: original, secret: webhookSecret });
      const tampered = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_999_HACKED" } } });
      expect(provider().verifyWebhookSignature(tampered, header)).toBe(false);
    });

    it("rejects a missing signature header outright", () => {
      expect(provider().verifyWebhookSignature("{}", "")).toBe(false);
    });

    it("parseWebhookEvent extracts id/type/data.object correctly", () => {
      const payload = JSON.stringify({ id: "evt_42", type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "active" } } });
      const parsed = provider().parseWebhookEvent(payload);
      expect(parsed.provider).toBe("stripe");
      expect(parsed.providerEventId).toBe("evt_42");
      expect(parsed.eventType).toBe("customer.subscription.updated");
      expect(parsed.data).toEqual({ id: "sub_1", status: "active" });
    });
  });
});
