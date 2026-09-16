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

/**
 * PAID2YOU — B0-D ADYEN PHASE 2 (bank-account collection/tokenization). The REPLACEMENT architecture
 * for `LinkBankAccountInput`/`TokenizeBankAccountInput`/`CreatePaymentMethodTokenInput` above, which
 * were always documented as "the fallback architecture... not the target one" (see
 * `TokenizeBankAccountInput`'s own doc comment) for exactly this day — a real production provider is
 * now selected, and its own hosted/tokenized collection widget is available. Those three interface
 * members are deliberately left in place (still implementable, still part of this interface) rather
 * than removed, so this change stays additive or dependent code doesn't need to change — but no
 * production code path calls them anymore; `BankConnectionService` now exclusively uses the methods
 * below. A future non-Adyen provider implementing `PaymentProvider` would implement THESE, not those.
 *
 * The whole point of this shape is that raw bank credentials never reach Paid2You's server at all:
 * the client collects them directly into the provider's own hosted Web Component, talking DIRECTLY to
 * the provider using this session's own scoped credentials — never routed through Paid2You's server,
 * encrypted or otherwise. Paid2You's server only ever sees this session's own opaque identity
 * (`providerSessionId`) and, once the provider's own webhooks durably confirm both the originating
 * transaction AND the resulting token, the resulting SAFE reference — never the bank details
 * themselves, and never inferred from a token list snapshot (see PHASE 2A CORRECTION below).
 *
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction): Phase 2's original design
 * additionally exposed `listStoredPaymentMethods`, used by `BankConnectionService` to diff a
 * "before" and "after" snapshot of the shopper's tokens and infer which one this attempt produced.
 * That mechanism is REMOVED — inferring ownership/attribution from a list-difference, token count, or
 * timestamp is never provable (a concurrent second attempt for the same shopper, or any other token
 * appearing/disappearing between the two snapshots, could misattribute a token that was never this
 * attempt's own). Token attribution now happens exclusively through Adyen-authenticated webhook data
 * matched against this session's own `merchantReference` (`CreateBankAccountSessionInput`) and the
 * durable `bank_link_attempt` row it is persisted against — see that table's own doc comment
 * (`src/db/schema/bankLinkAttempt.ts`) for the complete correlation chain. `listStoredPaymentMethods`
 * and `StoredPaymentMethodSummary` no longer exist on this interface.
 */
export interface CreateBankAccountSessionInput {
  /**
   * The provider-side shopper identity to create this session (and any resulting stored payment
   * method) under — always derived server-side from the authenticated Paid2You profile via
   * `PaymentProvider.deriveShopperReference`, never client-suppliable. This is the SAME identity a
   * later `createPayment` call for this profile must present to actually charge the resulting token.
   */
  shopperReference: string;
  /** Where the provider's own hosted flow redirects the shopper back to on completion (some payment methods require this even when the primary UX is a non-redirect Component). */
  returnUrl: string;
  /**
   * PAID2YOU — B0-D ADYEN PHASE 2A: this server's own chosen correlation key (a fresh, unique value
   * per attempt) — becomes the resulting transaction's `merchantReference`, which an incoming
   * AUTHORISATION webhook carries back verbatim. The CALLER generates and persists this (on the
   * `bank_link_attempt` row) before the session even exists, so the webhook-side correlation lookup
   * is always possible regardless of delivery timing.
   */
  merchantReference: string;
}
export interface CreateBankAccountSessionResult {
  providerSessionId: string;
  /** Opaque, provider-signed payload the CLIENT-side SDK needs to resume this exact session — never inspected/parsed by Paid2You's own server. */
  sessionData: string;
}

export interface DisableStoredPaymentMethodInput {
  shopperReference: string;
  storedPaymentMethodId: string;
}

export type PaymentProviderPaymentStatus = "pending" | "succeeded" | "failed";

export interface CreatePaymentInput {
  idempotencyKey: string;
  amountMinorUnits: number;
  currency: string;
  payer: ProfileRef;
  recipient: ProfileRef;
  /**
   * PAID2YOU — B0-D ADYEN PHASE 1A: the exact provider-side stored payment-method reference (e.g.
   * Adyen's `storedPaymentMethodId`) to charge — never a hint a real adapter is expected to resolve
   * on its own (no shopper-reference lookup, no "pick the only one," no guessing). Optional at the
   * TYPE level only so the many pre-existing tests/fakes exercising unrelated concerns via the
   * sandbox provider (which does not need one) are unaffected — a real, production-tagged adapter
   * (`AdyenPaymentProvider`) enforces this as REQUIRED at runtime and fails closed
   * (`ValidationError`) if it is missing or empty. `PaymentService.submitToProvider` resolves this
   * from Paid2You's own persisted state (the agreement's active ACH mandate's provider bank-account
   * reference) before calling `createPayment` — see that method's own doc comment.
   */
  providerPaymentMethodRef?: string;
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
 *
 * PAID2YOU — B0-D ADYEN PHASE 1B (item 2): `feeMinorUnits: null` is the explicit, disclosed
 * "genuinely unknown at this lookup layer" value (e.g. Adyen's `createPayment`-based
 * idempotency-replay fallback in `FailedPaymentRetryCoordinator`, which has no per-transaction fee to
 * report) — still never `undefined`/omitted, and still never silently coerced into a fabricated `0`
 * that would misrepresent what the provider actually charged. Distinct from an explicit `0`, which
 * remains a real, provider-confirmed "no fee" claim.
 */
export interface RetrievePaymentResult {
  providerPaymentId: string;
  status: PaymentProviderPaymentStatus;
  amountMinorUnits: number;
  currency: string;
  feeMinorUnits: number | null;
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
  /**
   * PAID2YOU — B0-D ADYEN PHASE 2: the provider's own deterministic derivation of its shopper identity
   * from a Paid2You profile — pure, synchronous, never a network call. The SAME derivation must be
   * used at tokenization time (`createBankAccountSession`) and at charge time (`createPayment`'s own
   * `shopperReference` construction) for a stored payment method to actually be usable — defined once,
   * here, so the two call sites (and `BankConnectionService`) can never drift apart.
   */
  deriveShopperReference(profile: ProfileRef): string;
  /** See CreateBankAccountSessionInput's own doc comment for the whole-flow rationale. */
  createBankAccountSession(input: CreateBankAccountSessionInput): Promise<CreateBankAccountSessionResult>;
  /** Makes a stored payment method permanently unusable for future payments. Idempotent: disabling an already-disabled/nonexistent token is not an error. */
  disableStoredPaymentMethod(input: DisableStoredPaymentMethodInput): Promise<void>;
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
