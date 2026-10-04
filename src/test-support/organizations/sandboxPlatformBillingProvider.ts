import "server-only";
import { randomUUID } from "node:crypto";
import { ValidationError } from "@/lib/errors";
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
} from "@/lib/organizations/platformBillingProvider";
import { computeHmacSignature, verifyHmacSignature } from "@/lib/webhookSignature";

interface SandboxSubscriptionState {
  status: ProviderSubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  invoices: ProviderInvoice[];
}

/**
 * Test-double only (mirrors src/test-support/kyc/sandboxKycProvider.ts's own "relocated out of the
 * production tree" precedent — never imported by getPlatformBillingProvider.ts or
 * providerCapabilities.ts). Simulates a real recurring-billing provider closely enough for
 * PlatformBillingService's own unit tests: a customer has payment methods; a subscription has a
 * billing period and a running invoice history; `simulatePaymentFailure`/`simulateInvoicePaid` let a
 * test move state the way a real provider's webhook would, never automatically.
 */
export class SandboxPlatformBillingProvider implements PlatformBillingProvider {
  readonly providerName = "sandbox_platform_billing_mock";
  readonly providerEnvironment = "production" as const;
  private readonly subscriptions = new Map<string, SandboxSubscriptionState>();
  private readonly paymentMethodsBySubscription = new Map<string, AttachPaymentMethodResult>();
  private readonly pendingCheckouts = new Map<string, { providerCustomerReference: string; planCode: string }>();

  constructor(private readonly webhookSecret: string) {}

  async ensureCustomer(_input: EnsureCustomerInput): Promise<EnsureCustomerResult> {
    return { providerCustomerReference: `sandbox_cust_${randomUUID()}` };
  }

  async attachPaymentMethod(_input: AttachPaymentMethodInput): Promise<AttachPaymentMethodResult> {
    return { providerPaymentMethodReference: `sandbox_pm_${randomUUID()}`, paymentType: "card", displayLast4: "4242", displayName: "Sandbox Visa" };
  }

  async startSubscription(_input: StartSubscriptionInput): Promise<StartSubscriptionResult> {
    const providerSubscriptionReference = `sandbox_sub_${randomUUID()}`;
    const now = new Date();
    const currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    this.subscriptions.set(providerSubscriptionReference, {
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd,
      invoices: [
        {
          providerInvoiceReference: `sandbox_inv_${randomUUID()}`,
          amountDueMinorUnits: 0,
          amountPaidMinorUnits: 0,
          status: "open",
          periodStart: now,
          periodEnd: currentPeriodEnd,
          dueAt: now,
          paidAt: null,
        },
      ],
    });
    return { providerSubscriptionReference, currentPeriodStart: now, currentPeriodEnd };
  }

  async retrieveSubscriptionState(providerSubscriptionReference: string): Promise<RetrieveSubscriptionStateResult> {
    const state = this.require(providerSubscriptionReference);
    return { providerSubscriptionReference, status: state.status, currentPeriodStart: state.currentPeriodStart, currentPeriodEnd: state.currentPeriodEnd };
  }

  async payInvoice(providerInvoiceReference: string): Promise<PayInvoiceResult> {
    for (const state of this.subscriptions.values()) {
      const invoice = state.invoices.find((i) => i.providerInvoiceReference === providerInvoiceReference);
      if (invoice) {
        invoice.status = "paid";
        invoice.amountPaidMinorUnits = invoice.amountDueMinorUnits;
        invoice.paidAt = new Date();
        return { paid: true, paidAt: invoice.paidAt, failureCode: null };
      }
    }
    throw new ValidationError("Unknown invoice reference.");
  }

  async changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
    this.require(input.providerSubscriptionReference);
    return { providerSubscriptionReference: input.providerSubscriptionReference, effectiveAt: new Date() };
  }

  async cancelAtPeriodEnd(providerSubscriptionReference: string): Promise<void> {
    this.require(providerSubscriptionReference);
  }

  async reactivate(providerSubscriptionReference: string): Promise<void> {
    const state = this.require(providerSubscriptionReference);
    state.status = "active";
  }

  async listInvoices(providerSubscriptionReference: string): Promise<ProviderInvoice[]> {
    return [...this.require(providerSubscriptionReference).invoices];
  }

  async createBillingPortalSession(_providerCustomerReference: string, returnUrl: string): Promise<{ hostedUrl: string }> {
    return { hostedUrl: `${returnUrl}?sandbox_portal_session=${randomUUID()}` };
  }

  /**
   * Test-double only — mirrors `StripePlatformBillingProvider.createCheckoutSession`'s own contract
   * exactly: creating a session never itself starts a subscription or attaches a payment method. A
   * test completes the simulated hosted flow via `simulateCheckoutCompleted` below, exactly the way a
   * real `checkout.session.completed` webhook would.
   */
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult> {
    const providerSessionReference = `sandbox_checkout_${randomUUID()}`;
    this.pendingCheckouts.set(providerSessionReference, { providerCustomerReference: input.providerCustomerReference, planCode: input.planCode });
    const hostedUrl = new URL(input.successUrl);
    hostedUrl.searchParams.set("sandbox_checkout_session", providerSessionReference);
    return { hostedUrl: hostedUrl.toString(), providerSessionReference };
  }

  async retrieveSubscriptionPaymentMethod(providerSubscriptionReference: string): Promise<AttachPaymentMethodResult> {
    this.require(providerSubscriptionReference);
    const pm = this.paymentMethodsBySubscription.get(providerSubscriptionReference);
    if (!pm) throw new ValidationError(`No payment method attached to subscription "${providerSubscriptionReference}" yet.`);
    return pm;
  }

  /**
   * Test/sandbox-simulator helper — completes a previously created checkout session exactly like a
   * real `checkout.session.completed` webhook delivery would: starts a real sandbox subscription and
   * attaches a payment method to it. Never called automatically — a test must call this explicitly to
   * simulate the Business actually completing Stripe's hosted page, proving the session's creation
   * alone never did.
   */
  simulateCheckoutCompleted(providerSessionReference: string): { providerCustomerReference: string; providerSubscriptionReference: string } {
    const pending = this.pendingCheckouts.get(providerSessionReference);
    if (!pending) throw new ValidationError("Unknown checkout session reference.");
    const providerSubscriptionReference = `sandbox_sub_${randomUUID()}`;
    const now = new Date();
    const currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    this.subscriptions.set(providerSubscriptionReference, { status: "active", currentPeriodStart: now, currentPeriodEnd, invoices: [] });
    this.paymentMethodsBySubscription.set(providerSubscriptionReference, {
      providerPaymentMethodReference: `sandbox_pm_${randomUUID()}`,
      paymentType: "card",
      displayLast4: "4242",
      displayName: "Sandbox Visa",
    });
    this.pendingCheckouts.delete(providerSessionReference);
    return { providerCustomerReference: pending.providerCustomerReference, providerSubscriptionReference };
  }

  /** Test/sandbox-simulator helper — mirrors a real provider's async failed-payment webhook. */
  simulatePaymentFailure(providerSubscriptionReference: string): void {
    this.require(providerSubscriptionReference).status = "payment_failed";
  }

  /** Test/sandbox-simulator helper — "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-4: lets a test set any of the existing `ProviderSubscriptionStatus` values directly, to prove the webhook service's own activation gate for each one — never a NEW status value, just direct control over an existing one for test purposes. */
  simulateSubscriptionStatus(providerSubscriptionReference: string, status: ProviderSubscriptionStatus): void {
    this.require(providerSubscriptionReference).status = status;
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    return verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret);
  }

  parseWebhookEvent(rawBody: string): ParsedPlatformBillingWebhookEvent {
    let parsed: { providerEventId?: unknown; eventType?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new ValidationError("Webhook payload is not valid JSON.");
    }
    if (typeof parsed.providerEventId !== "string" || typeof parsed.eventType !== "string") {
      throw new ValidationError("Webhook payload is missing providerEventId/eventType.");
    }
    return { provider: this.providerName, providerEventId: parsed.providerEventId, eventType: parsed.eventType, data: parsed };
  }

  /** Test/sandbox-simulator helper — produces a signature a real caller would send in the webhook's signature header. */
  signWebhookPayload(rawBody: string): string {
    return computeHmacSignature(rawBody, this.webhookSecret);
  }

  private require(providerSubscriptionReference: string): SandboxSubscriptionState {
    const state = this.subscriptions.get(providerSubscriptionReference);
    if (!state) throw new ValidationError("Unknown subscription reference.");
    return state;
  }
}
