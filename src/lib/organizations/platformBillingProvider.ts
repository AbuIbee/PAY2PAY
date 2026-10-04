import "server-only";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 10/Requirement 20/21/39: Paid2You's OWN
 * recurring-billing boundary — organizations paying Paid2You for their subscription — deliberately
 * separate from `src/lib/payments/paymentProvider.ts` (tenant/customer money movement). Mirrors that
 * file's own factory/fail-closed shape (see getPlatformBillingProvider.ts) but is a wholly distinct
 * interface: no shared method, no shared provider instance, no shared credentials. `paymentMethodToken`
 * below is always an opaque token already produced by a provider-hosted component (mirrors
 * `PaymentProvider.tokenizeBankAccount`'s own non-persistence contract) — raw card/bank data never
 * passes through this interface or any implementation of it.
 */
export interface EnsureCustomerInput {
  organizationId: string;
  billingEmail: string;
  legalName: string;
}

export interface EnsureCustomerResult {
  providerCustomerReference: string;
}

export type SubscriptionPaymentMethodKind = "card" | "bank_account" | "other";

export interface AttachPaymentMethodInput {
  providerCustomerReference: string;
  /** Opaque token from a provider-hosted component — never raw card/bank data. */
  paymentMethodToken: string;
}

export interface AttachPaymentMethodResult {
  providerPaymentMethodReference: string;
  paymentType: SubscriptionPaymentMethodKind;
  displayLast4: string | null;
  displayName: string | null;
}

export interface StartSubscriptionInput {
  providerCustomerReference: string;
  providerPaymentMethodReference: string;
  planCode: string;
}

export interface StartSubscriptionResult {
  providerSubscriptionReference: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

/**
 * "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-4: `"trialing"` is its own distinct
 * value, never folded into `"active"` — Paid2You has no approved trial product, so only a genuinely
 * `"active"` provider subscription may ever be treated as eligible for Business activation
 * (`PlatformBillingWebhookService`'s own `isEligibleForActivation`/activation-gate checks already
 * compare against the literal `"active"` string; this value exists so a trialing Stripe subscription
 * can no longer satisfy that comparison by being silently collapsed into it beforehand).
 */
export type ProviderSubscriptionStatus = "active" | "trialing" | "payment_failed" | "past_due" | "canceled" | "suspended";

export interface RetrieveSubscriptionStateResult {
  providerSubscriptionReference: string;
  status: ProviderSubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export interface PayInvoiceResult {
  paid: boolean;
  paidAt: Date | null;
  failureCode: string | null;
}

export interface ChangePlanInput {
  providerSubscriptionReference: string;
  newPlanCode: string;
  effective: "immediate" | "next_period";
}

export interface ChangePlanResult {
  providerSubscriptionReference: string;
  effectiveAt: Date;
}

export type SubscriptionInvoiceStatus = "open" | "paid" | "past_due" | "void";

export interface ProviderInvoice {
  providerInvoiceReference: string;
  amountDueMinorUnits: number;
  amountPaidMinorUnits: number;
  status: SubscriptionInvoiceStatus;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  paidAt: Date | null;
}

export interface CreateCheckoutSessionInput {
  providerCustomerReference: string;
  planCode: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutSessionResult {
  hostedUrl: string;
  providerSessionReference: string;
}

export interface ParsedPlatformBillingWebhookEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  data: Record<string, unknown>;
}

/**
 * Real implementation: a future production adapter selected through getPlatformBillingProvider.ts.
 * No such adapter exists yet — see that file's own doc comment and providerCapabilities.ts's empty
 * registry entry for `platform_billing`. Never expose Paid2You's own bank account/routing number/
 * provider API secrets through any implementation of this interface (Section 10) — only opaque
 * references ever cross this boundary.
 */
export interface PlatformBillingProvider {
  readonly providerName: string;
  readonly providerEnvironment: "production";
  ensureCustomer(input: EnsureCustomerInput): Promise<EnsureCustomerResult>;
  attachPaymentMethod(input: AttachPaymentMethodInput): Promise<AttachPaymentMethodResult>;
  startSubscription(input: StartSubscriptionInput): Promise<StartSubscriptionResult>;
  retrieveSubscriptionState(providerSubscriptionReference: string): Promise<RetrieveSubscriptionStateResult>;
  payInvoice(providerInvoiceReference: string): Promise<PayInvoiceResult>;
  changePlan(input: ChangePlanInput): Promise<ChangePlanResult>;
  cancelAtPeriodEnd(providerSubscriptionReference: string): Promise<void>;
  reactivate(providerSubscriptionReference: string): Promise<void>;
  listInvoices(providerSubscriptionReference: string): Promise<ProviderInvoice[]>;
  /**
   * "PAID2YOU — MASTER P0" (2026-10-03), Section 29: an official provider-hosted "Change Payment
   * Method" experience (e.g. Stripe's Billing Portal) — returns a URL to redirect the organization's
   * billing administrator to; this application never renders a raw card-entry form. Not every
   * provider need support this identically; a provider without a hosted equivalent may throw
   * `ProviderCapabilityUnsupportedError` rather than fabricate one.
   */
  createBillingPortalSession(providerCustomerReference: string, returnUrl: string): Promise<{ hostedUrl: string }>;
  /**
   * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7: the real initial-billing
   * entry point — an official provider-hosted checkout page (e.g. Stripe Checkout in subscription
   * mode). The Business is NEVER expected to manually supply a provider PaymentMethod id; they are
   * redirected to this URL, enter payment details on the PROVIDER's own hosted page, and are
   * redirected back. Creating this session must never itself mark anything active — only a
   * subsequent, provider-confirmed webhook does (see `retrieveSubscriptionPaymentMethod` below and
   * `PlatformBillingWebhookService`'s own `checkout.session.completed` handling).
   */
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult>;
  /**
   * Section 7: once a checkout session completes (confirmed only via webhook, never via the
   * redirect alone), retrieves the actual payment method the provider attached — safe display
   * metadata only (reuses `AttachPaymentMethodResult`'s exact shape; never raw card data).
   */
  retrieveSubscriptionPaymentMethod(providerSubscriptionReference: string): Promise<AttachPaymentMethodResult>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
  parseWebhookEvent(rawBody: string): ParsedPlatformBillingWebhookEvent;
}
