import "server-only";

export type ProfileKind = "personal" | "business";

export interface ProfileRef {
  profileKind: ProfileKind;
  profileId: string;
}

export interface CreateRecipientAccountInput {
  recipient: ProfileRef;
}
export interface CreateRecipientAccountResult {
  providerAccountId: string;
  payoutCapable: boolean;
}

export interface LinkBankAccountInput {
  profile: ProfileRef;
  providerAccountId: string;
}
export interface LinkBankAccountResult {
  providerBankAccountRef: string;
}

export interface CreatePaymentMethodTokenInput {
  profile: ProfileRef;
  methodKind: "ach" | "debit_card";
}
export interface CreatePaymentMethodTokenResult {
  providerPaymentMethodToken: string;
}

export type PaymentProviderPaymentStatus = "pending" | "succeeded" | "failed";

export interface CreatePaymentInput {
  idempotencyKey: string;
  amountMinorUnits: number;
  currency: string;
  payer: ProfileRef;
  recipient: ProfileRef;
  /**
   * Sandbox-only test hook, never present on a real processor adapter's input. Defaults to
   * "pending" (models an ACH-style submit-then-settle-async flow) when omitted.
   * "processor_error" simulates a synchronous processor/network failure (distinct from a
   * legitimate decline, which is `status: "failed"`).
   */
  simulateOutcome?: "pending" | "succeeded" | "failed" | "processor_error";
}
export interface CreatePaymentResult {
  providerPaymentId: string;
  status: PaymentProviderPaymentStatus;
}

export interface RetrievePaymentResult {
  providerPaymentId: string;
  status: PaymentProviderPaymentStatus;
}

export interface CancelPaymentResult {
  canceled: boolean;
}

export interface RefundPaymentResult {
  providerRefundId: string;
}

export interface ParsedWebhookEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  data: Record<string, unknown>;
}

/**
 * Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md) provider-independent
 * payment abstraction. Application business logic (PaymentService) depends only on this interface,
 * never on a specific processor's SDK/API shape — a future Stripe Connect or Plaid-backed adapter
 * (Sprint 11/12 per this sprint's text) implements the same interface with zero change required to
 * PaymentService or any of its callers. `providerName` is the mechanism by which webhook events and
 * stored payment_attempt rows are attributed to a specific integration without ever using a
 * provider-issued id as an internal primary/foreign key.
 */
export interface PaymentProvider {
  readonly providerName: string;
  /**
   * PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md): declares
   * this instance's own environment — must always match the same provider's entry in
   * src/lib/providers/providerCapabilities.ts's registry (getPaymentProvider() asserts this at
   * construction time via assertProviderEnvironmentConsistency).
   */
  readonly providerEnvironment: "sandbox" | "production";
  createRecipientAccount(input: CreateRecipientAccountInput): Promise<CreateRecipientAccountResult>;
  linkBankAccount(input: LinkBankAccountInput): Promise<LinkBankAccountResult>;
  createPaymentMethodToken(input: CreatePaymentMethodTokenInput): Promise<CreatePaymentMethodTokenResult>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  retrievePayment(providerPaymentId: string): Promise<RetrievePaymentResult>;
  /** "cancel when permitted" — the provider itself decides whether a given payment id is still cancelable; PaymentService additionally restricts this to its own "pending" records. */
  cancelPayment(providerPaymentId: string): Promise<CancelPaymentResult>;
  refundPayment(providerPaymentId: string, amountMinorUnits?: number): Promise<RefundPaymentResult>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
  parseWebhookEvent(rawBody: string): ParsedWebhookEvent;
}
