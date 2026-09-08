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

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md): the fallback-architecture
 * bank-account tokenization boundary — "if raw bank values must transit Paid2You... immediately
 * exchange them for the provider's safe token/reference, discard them immediately after exchange."
 * Every implementer of this method must accept the raw values, exchange them for a safe reference, and
 * return ONLY non-sensitive fields — it must never persist, log, or otherwise retain
 * `routingNumber`/`accountNumber` beyond the lifetime of this single call. The preferred, non-fallback
 * architecture (a provider-hosted/tokenized collection widget) is not available in sandbox because no
 * production financial provider has been selected (see docs/PRODUCTION_PROVIDER_READINESS.md) — this
 * is the documented, deliberate fallback, not the target architecture.
 */
export interface TokenizeBankAccountInput {
  profile: ProfileRef;
  routingNumber: string;
  accountNumber: string;
  accountSubtype: "checking" | "savings";
  accountHolderName: string;
}
export interface TokenizeBankAccountResult {
  providerAccountRef: string;
  maskedLast4: string;
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

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Part B): an authoritative
 * resolved-payment lookup must carry the COMPLETE financial evidence the event/effect pipeline needs
 * to safely post a ledger entry from it — never merely identity + status. `amountMinorUnits`/
 * `currency` let a consumer cross-check the provider's own authoritative record against whatever it
 * internally expected (a genuine mismatch is a real anomaly, never silently accepted). `feeMinorUnits`
 * is the provider/processor's OWN fee for this payment — every implementer must return an explicit
 * value, never `undefined`/omitted: a provider that genuinely charges no fee (e.g. this codebase's own
 * sandbox, which never simulates a processor fee at the provider-API layer — see
 * `SandboxPaymentProvider`'s own doc comment) returns `feeMinorUnits: 0` explicitly, normalized inside
 * the adapter itself — generic webhook/ledger code must NEVER invent this value on the provider's
 * behalf when it is merely absent/unknown.
 */
export interface RetrievePaymentResult {
  providerPaymentId: string;
  status: PaymentProviderPaymentStatus;
  amountMinorUnits: number;
  currency: string;
  feeMinorUnits: number;
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
  /** See TokenizeBankAccountInput's own doc comment for the non-persistence contract every implementer must honor. */
  tokenizeBankAccount(input: TokenizeBankAccountInput): Promise<TokenizeBankAccountResult>;
  createPaymentMethodToken(input: CreatePaymentMethodTokenInput): Promise<CreatePaymentMethodTokenResult>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  retrievePayment(providerPaymentId: string): Promise<RetrievePaymentResult>;
  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2/3): the narrowest lookup
   * capability needed to resolve an AMBIGUOUS `createPayment` call (the request may have reached the
   * provider, but the application never durably observed a resolved response) — never a new
   * submission, always keyed by the SAME durable idempotency identity the original attempt used.
   * Returns `null` when the provider has no record of this idempotency key at all (a definitive
   * "not found" the caller may use to decide whether resubmission is safe under its own retry
   * policy) — never throws for "not found" specifically. A real (non-sandbox) processor adapter
   * implementing this is explicit R10 scope; `SandboxPaymentProvider`'s own implementation proves the
   * APPLICATION-side recovery flow, not production provider readiness.
   */
  retrievePaymentByIdempotencyKey(idempotencyKey: string): Promise<RetrievePaymentResult | null>;
  /** "cancel when permitted" — the provider itself decides whether a given payment id is still cancelable; PaymentService additionally restricts this to its own "pending" records. */
  cancelPayment(providerPaymentId: string): Promise<CancelPaymentResult>;
  refundPayment(providerPaymentId: string, amountMinorUnits?: number): Promise<RefundPaymentResult>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
  parseWebhookEvent(rawBody: string): ParsedWebhookEvent;
}
