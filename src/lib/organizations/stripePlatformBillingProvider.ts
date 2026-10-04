import "server-only";
import Stripe from "stripe";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import type {
  AttachPaymentMethodInput,
  AttachPaymentMethodResult,
  ChangePlanInput,
  ChangePlanResult,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  EnsureCustomerInput,
  EnsureCustomerResult,
  ParsedPlatformBillingWebhookEvent,
  PayInvoiceResult,
  PlatformBillingProvider,
  ProviderInvoice,
  ProviderSubscriptionStatus,
  RetrieveSubscriptionStateResult,
  StartSubscriptionInput,
  StartSubscriptionResult,
} from "./platformBillingProvider";

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 17-33: real Stripe Billing adapter implementing the
 * existing `PlatformBillingProvider` interface — Paid2You's OWN recurring subscription billing
 * domain, NEVER customer-to-customer repayment money movement (Section 6/18's own "Stripe is NOT the
 * customer repayment rail" — this class has no method, no credential, and no code path that could
 * ever initiate or touch a customer repayment; `PaymentProvider`, the customer-money-movement
 * interface, is a wholly separate file this class never imports).
 *
 * PAYMENT DATA BOUNDARY (Section 18): `paymentMethodToken` (the interface's own opaque-token
 * contract) is always a Stripe PaymentMethod ID already produced by a Stripe-hosted component
 * (Elements/Checkout/Setup Session) on the client — this adapter calls `paymentMethods.attach`, never
 * `paymentMethods.create` with raw card fields, so no raw card number/CVC ever passes through this
 * process. Only opaque Stripe references (customer/subscription/payment-method/invoice ids) and safe
 * display metadata (type/last4/brand-ish display name) ever leave this class.
 *
 * IDEMPOTENT CUSTOMER MAPPING (Section 20): `ensureCustomer`/`startSubscription` pass a
 * deterministic Stripe `idempotencyKey` derived from `organizationId`/`providerCustomerReference` —
 * a retried call with the same inputs can never create a second Stripe customer or a second
 * subscription for the same organization.
 *
 * STATUS NOTE (Section 68): this adapter is built directly against the official `stripe` Node SDK
 * and its well-published, stable API shapes (Subscriptions, Invoices, PaymentMethods, Customers,
 * Billing Portal) — CODE COMPLETE. It has not been exercised against a real Stripe account (no
 * credentials exist in this environment — Section 19's own "do not create provider accounts" / "do
 * not hardcode live Stripe identifiers" boundary), so it is NOT yet LIVE VERIFIED; see
 * docs/FIRST_LIVE_BUSINESS_ACCEPTANCE.md for the controlled first real exercise of this path.
 */
export class StripePlatformBillingProvider implements PlatformBillingProvider {
  readonly providerName = "stripe";
  readonly providerEnvironment = "production" as const;
  private readonly stripe: Stripe;

  constructor(
    private readonly config: {
      secretKey: string;
      webhookSecret: string;
      priceIdByPlanCode: Readonly<Record<string, string | undefined>>;
    },
  ) {
    this.stripe = new Stripe(config.secretKey, { apiVersion: "2024-11-20.acacia" });
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<EnsureCustomerResult> {
    const customer = await this.stripe.customers.create(
      { email: input.billingEmail, name: input.legalName, metadata: { organizationId: input.organizationId } },
      { idempotencyKey: `p2y_customer_${input.organizationId}` },
    );
    return { providerCustomerReference: customer.id };
  }

  async attachPaymentMethod(input: AttachPaymentMethodInput): Promise<AttachPaymentMethodResult> {
    const pm = await this.stripe.paymentMethods.attach(input.paymentMethodToken, { customer: input.providerCustomerReference });
    await this.stripe.customers.update(input.providerCustomerReference, {
      invoice_settings: { default_payment_method: pm.id },
    });
    return mapPaymentMethod(pm);
  }

  async startSubscription(input: StartSubscriptionInput): Promise<StartSubscriptionResult> {
    const priceId = this.requirePriceId(input.planCode);
    const subscription = await this.stripe.subscriptions.create(
      {
        customer: input.providerCustomerReference,
        items: [{ price: priceId }],
        default_payment_method: input.providerPaymentMethodReference,
        metadata: { planCode: input.planCode },
      },
      { idempotencyKey: `p2y_sub_start_${input.providerCustomerReference}` },
    );
    return {
      providerSubscriptionReference: subscription.id,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    };
  }

  async retrieveSubscriptionState(providerSubscriptionReference: string): Promise<RetrieveSubscriptionStateResult> {
    const subscription = await this.stripe.subscriptions.retrieve(providerSubscriptionReference);
    return {
      providerSubscriptionReference,
      status: mapStripeSubscriptionStatus(subscription.status),
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    };
  }

  async payInvoice(providerInvoiceReference: string): Promise<PayInvoiceResult> {
    try {
      const invoice = await this.stripe.invoices.pay(providerInvoiceReference);
      return { paid: invoice.status === "paid", paidAt: invoice.status === "paid" ? new Date() : null, failureCode: null };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) {
        return { paid: false, paidAt: null, failureCode: error.code ?? "card_error" };
      }
      throw error;
    }
  }

  /**
   * Section 30/31: "immediate" (upgrade — the only self-service path the accepted route layer ever
   * reaches) prorates and invoices right away; "next_period" (downgrade) is intentionally NOT
   * reachable from the accepted self-service route (src/app/api/organizations/billing/change-plan/route.ts
   * rejects a downgrade before this method is ever called) — implemented here only so the interface
   * contract is honestly satisfiable, never exercised by any production code path today.
   */
  async changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
    const priceId = this.requirePriceId(input.newPlanCode);
    const subscription = await this.stripe.subscriptions.retrieve(input.providerSubscriptionReference);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) throw new ConfigurationError(`Stripe subscription "${input.providerSubscriptionReference}" has no subscription item to change.`);

    if (input.effective === "immediate") {
      const updated = await this.stripe.subscriptions.update(input.providerSubscriptionReference, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: "always_invoice",
      });
      return { providerSubscriptionReference: updated.id, effectiveAt: new Date() };
    }
    const updated = await this.stripe.subscriptions.update(input.providerSubscriptionReference, {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: "none",
      billing_cycle_anchor: "unchanged",
    });
    return { providerSubscriptionReference: updated.id, effectiveAt: new Date(updated.current_period_end * 1000) };
  }

  async cancelAtPeriodEnd(providerSubscriptionReference: string): Promise<void> {
    await this.stripe.subscriptions.update(providerSubscriptionReference, { cancel_at_period_end: true });
  }

  async reactivate(providerSubscriptionReference: string): Promise<void> {
    await this.stripe.subscriptions.update(providerSubscriptionReference, { cancel_at_period_end: false });
  }

  async listInvoices(providerSubscriptionReference: string): Promise<ProviderInvoice[]> {
    const invoices = await this.stripe.invoices.list({ subscription: providerSubscriptionReference, limit: 100 });
    return invoices.data.map((inv) => ({
      providerInvoiceReference: inv.id,
      amountDueMinorUnits: inv.amount_due,
      amountPaidMinorUnits: inv.amount_paid,
      status: mapStripeInvoiceStatus(inv.status),
      periodStart: new Date((inv.period_start ?? inv.created) * 1000),
      periodEnd: new Date((inv.period_end ?? inv.created) * 1000),
      dueAt: new Date((inv.due_date ?? inv.created) * 1000),
      paidAt: inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : null,
    }));
  }

  /**
   * Section 29: official Stripe-hosted Customer Portal — Change Payment Method without this
   * application ever rendering a raw card-entry form. Not part of `PlatformBillingProvider`'s own
   * interface shape (every other provider there would need to answer "what does this even mean"); a
   * narrow, Stripe-specific capability check instead (mirrors this codebase's existing
   * `isPlatformBillingProviderConfigured`-style "feature-specific availability" precedent) — see
   * getPlatformBillingProvider.ts's `createBillingPortalSessionIfSupported`.
   */
  async createBillingPortalSession(providerCustomerReference: string, returnUrl: string): Promise<{ hostedUrl: string }> {
    const session = await this.stripe.billingPortal.sessions.create({ customer: providerCustomerReference, return_url: returnUrl });
    return { hostedUrl: session.url };
  }

  /**
   * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7/9/10: creates a real Stripe
   * Checkout Session in subscription mode — the Business is redirected to `hostedUrl` (Stripe's own
   * hosted page) and enters payment details there; this call never itself starts a subscription or
   * attaches a payment method (Stripe does both atomically on the hosted page, confirmed back to this
   * application only via the `checkout.session.completed` webhook — see
   * `PlatformBillingWebhookService`). A short-lived `idempotencyKey` (same customer+plan) protects
   * against a double-submit creating two redirect targets for the same in-flight attempt, without
   * permanently blocking a genuinely new attempt after Stripe's own 24h idempotency window elapses.
   */
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult> {
    const priceId = this.requirePriceId(input.planCode);
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: input.providerCustomerReference,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: `p2y_checkout_${input.providerCustomerReference}_${input.planCode}` },
    );
    if (!session.url) {
      throw new ConfigurationError("Stripe did not return a hosted Checkout URL for this session.");
    }
    return { hostedUrl: session.url, providerSessionReference: session.id };
  }

  /**
   * Section 7: called only after a `checkout.session.completed` webhook confirms the session — never
   * from the redirect alone. Retrieves the real payment method Stripe itself attached as this
   * subscription's default during hosted checkout; safe display metadata only (same shape as
   * `attachPaymentMethod`'s own result, never raw card data).
   */
  async retrieveSubscriptionPaymentMethod(providerSubscriptionReference: string): Promise<AttachPaymentMethodResult> {
    const subscription = await this.stripe.subscriptions.retrieve(providerSubscriptionReference, {
      expand: ["default_payment_method"],
    });
    const pm = subscription.default_payment_method;
    if (!pm || typeof pm === "string") {
      throw new ConfigurationError(`Stripe subscription "${providerSubscriptionReference}" has no attached default payment method yet.`);
    }
    return mapPaymentMethod(pm);
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    try {
      this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.config.webhookSecret);
      return true;
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: string): ParsedPlatformBillingWebhookEvent {
    let parsed: { id?: unknown; type?: unknown; data?: { object?: unknown } };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new ValidationError("Stripe webhook payload is not valid JSON.");
    }
    if (typeof parsed.id !== "string" || typeof parsed.type !== "string") {
      throw new ValidationError("Stripe webhook payload is missing \"id\"/\"type\".");
    }
    return { provider: this.providerName, providerEventId: parsed.id, eventType: parsed.type, data: (parsed.data?.object as Record<string, unknown>) ?? {} };
  }

  private requirePriceId(planCode: string): string {
    const priceId = this.config.priceIdByPlanCode[planCode];
    if (!priceId) {
      throw new ConfigurationError(`No Stripe Price ID is configured for plan "${planCode}" — set the matching STRIPE_<PLAN>_PRICE_ID environment variable before this plan can be started/changed to.`);
    }
    return priceId;
  }
}

/** Shared by `attachPaymentMethod` and `retrieveSubscriptionPaymentMethod` — safe display metadata only, never raw card/bank data. */
function mapPaymentMethod(pm: Stripe.PaymentMethod): AttachPaymentMethodResult {
  return {
    providerPaymentMethodReference: pm.id,
    paymentType: pm.type === "us_bank_account" ? "bank_account" : pm.type === "card" ? "card" : "other",
    displayLast4: pm.card?.last4 ?? pm.us_bank_account?.last4 ?? null,
    displayName: pm.card ? `${pm.card.brand} card` : pm.us_bank_account ? `${pm.us_bank_account.bank_name ?? "Bank"} account` : null,
  };
}

/**
 * Section 26: conservative mapping — never fabricates a status Stripe did not report.
 * "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-4 (Codex re-verification): `"trialing"`
 * no longer collapses into `"active"` — Paid2You has no approved Stripe trial product, so a trialing
 * subscription must never be treated as eligible for Business activation.
 */
export function mapStripeSubscriptionStatus(stripeStatus: Stripe.Subscription.Status): ProviderSubscriptionStatus {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "paused":
      return "suspended";
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    default:
      return "payment_failed";
  }
}

export function mapStripeInvoiceStatus(stripeStatus: Stripe.Invoice.Status | null): "open" | "paid" | "past_due" | "void" {
  switch (stripeStatus) {
    case "paid":
      return "paid";
    case "void":
    case "uncollectible":
      return "void";
    case "open":
      return "open";
    case "draft":
    default:
      return "open";
  }
}
