import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderCapabilityUnsupportedError, ValidationError } from "@/lib/errors";
import { AmbiguousProviderResponseError } from "@/lib/failedPayments/failedPaymentRetryCoordinator";
import type {
  CancelPaymentResult,
  CreateBankAccountSessionInput,
  CreateBankAccountSessionResult,
  CreatePaymentInput,
  CreatePaymentMethodTokenInput,
  CreatePaymentMethodTokenResult,
  CreatePaymentResult,
  CreateRecipientAccountInput,
  CreateRecipientAccountResult,
  DisableStoredPaymentMethodInput,
  LinkBankAccountInput,
  LinkBankAccountResult,
  ParsedWebhookEvent,
  PaymentProvider,
  PaymentProviderPaymentStatus,
  ProfileRef,
  RefundPaymentResult,
  RetrievePaymentResult,
  TokenizeBankAccountInput,
  TokenizeBankAccountResult,
} from "./paymentProvider";

/**
 * PAID2YOU — B0-D ADYEN PHASE 1 / 1A (Payment Provider Foundation).
 *
 * Real Adyen Checkout API adapter — no SDK dependency, calling Adyen's REST API directly via `fetch`,
 * matching this codebase's established zero-dependency convention for external providers
 * (ResendEmailSender/TwilioSmsSender). Registered as a `environment: "production"` descriptor in
 * `src/lib/providers/providerCapabilities.ts` — this class is structurally unreachable outside a
 * genuine `APP_ENV=production` deployment (`assertProviderAvailableForRuntime`) and only ever targets
 * Adyen's account-specific LIVE endpoint. It never constructs, references, or falls back to a
 * `*-test.adyen.com`/`checkout-test.adyen.com` URL — there is no test-endpoint code path in this file
 * at all, by design (Adyen's own test environment is a legitimate, Adyen-side concept for the humans
 * doing integration testing, orthogonal to this file, which never runs anywhere but production).
 *
 * API VERSION: pinned to Checkout API **v72** (Phase 1B — upgraded from v71; Adyen's own current
 * recommended version as of this phase) — a specific, fully-documented, stable release (not
 * "latest"/unpinned) with confirmed `/payments`, `/payments/{pspReference}/cancels`,
 * `/payments/{pspReference}/refunds` endpoints. Used consistently everywhere in this file via the one
 * `CHECKOUT_API_VERSION` constant/`checkoutBaseUrl()` — never mixed with another version. Verified (via
 * Adyen's own published v72 upgrade announcement and release-notes index; the interactive API-diff tool
 * itself is client-rendered and could not be scripted for a byte-level schema diff in this pass) that
 * v72's documented changes are stronger request validation/clearer error codes, Sessions/stored-payment/
 * partial-payment improvements, and new payment methods (AU PAY, d-barai) — none of which rename, drop,
 * or change the requiredness of any field this adapter sends (`merchantAccount`, `reference`, `amount`,
 * `paymentMethod.storedPaymentMethodId`, `shopperReference`, `shopperInteraction`,
 * `recurringProcessingModel`) or reads (`pspReference`, `resultCode`, `refusalReason`, modification
 * `status`) on `/payments`, `/cancels`, or `/refunds`. No concrete incompatibility was found requiring
 * v71.
 *
 * WEBHOOKS: JSON **Standard notification webhooks** (not SOAP, not a Balance Platform/configuration
 * webhook — those are a distinct product, a later B0-D phase). HMAC lives inside the JSON body
 * (`notificationItems[].NotificationRequestItem.additionalData.hmacSignature`), never an HTTP header.
 *
 * SCOPE — implemented (this phase only):
 *   createPayment, cancelPayment, refundPayment, verifyWebhookSignature, parseWebhookEvent.
 * SCOPE — deliberately throw "not implemented in this phase" (later B0-D phases, not this one):
 *   createRecipientAccount, linkBankAccount, tokenizeBankAccount, createPaymentMethodToken
 *   (bank-account collection / KYC / Balance Platform / Transfers / card issuing).
 *
 * PHASE 1A CORRECTIONS to Phase 1's original design, per a follow-up review:
 *
 *   1. EXACT PAYMENT METHOD (was: shopperReference lookup+guess). `createPayment` no longer calls
 *      `POST /paymentMethods` or picks a stored method on the payer's behalf — Phase 1's
 *      shopperReference-lookup design was exactly the kind of guessing this phase must not do.
 *      `CreatePaymentInput.providerPaymentMethodRef` (added to the shared interface — see that file's
 *      own doc comment) now carries the EXACT `storedPaymentMethodId` to charge, resolved by
 *      `PaymentService.submitToProvider` from Paid2You's own persisted state (the agreement's active
 *      ACH mandate's provider bank-account reference — see that method's own doc comment) before this
 *      adapter is ever called. Missing/empty → `ValidationError`, thrown before any network call.
 *
 *   2. RETRY/RECONCILIATION no longer depends on unsupported Adyen lookup behavior.
 *      `retrievePayment`/`retrievePaymentByIdempotencyKey` still throw (Adyen's Checkout API
 *      genuinely has no GET-by-reference endpoint — confirmed against Adyen's own docs; the only GET
 *      is `/sessions/{sessionId}`, unrelated), but now throw the specifically-typed
 *      `ProviderCapabilityUnsupportedError` rather than a plain `Error`, so callers can distinguish
 *      "this provider cannot do this" from a genuine failure and degrade safely:
 *      `ReconciliationService.reconcilePaymentAttempt` catches it and skips the affected check
 *      entirely (no false-positive exception recorded) rather than flagging every payment as
 *      "unmatched." `FailedPaymentRetryCoordinator` no longer calls either method at all — ambiguous
 *      retry resolution now re-submits `createPayment` with the SAME `idempotencyKey` (and the SAME
 *      exact `providerPaymentMethodRef`, re-resolved from persisted state), relying on Adyen's real,
 *      documented `Idempotency-Key` semantics (a repeated request with the same key returns Adyen's
 *      ORIGINAL cached response — never creates a second payment) — genuine "use persisted Paid2You
 *      state + Adyen pspReference + Idempotency-Key semantics," never an invented GET endpoint. This
 *      file's own `request()` helper additionally now throws `AmbiguousProviderResponseError`
 *      (`@/lib/failedPayments/failedPaymentRetryCoordinator` — the exact mechanism that module's own
 *      doc comment says "real provider adapters should throw... specifically for their own 'ambiguous'
 *      failure modes") for network-layer failures and 5xx responses — cases where the request may or
 *      may not have reached Adyen — so the coordinator's own existing ambiguity handling (never
 *      marking the payment definitively failed, never risking a duplicate on the next attempt)
 *      actually engages, instead of every such failure being misclassified as a definite rejection.
 *
 *   3. CANCEL/REFUND FINALITY: `cancelPayment`/`refundPayment` return whether Adyen ACCEPTED the
 *      request — never confirmation. `PaymentService.cancelPayment`/`refundPayment` (Phase 1A) no
 *      longer write a terminal local status on that acceptance alone; the payment stays
 *      "pending"/"succeeded" until the asynchronous `CANCELLATION`/`REFUND` webhook actually confirms
 *      it. `parseWebhookEvent` now maps `CANCELLATION` (success:true) to `"payment.canceled"` (a
 *      `PaymentAttemptStatus` that already existed but had no webhook-driven path to it — verified
 *      safe: every downstream consumer in `PaymentWebhookService` — ledger posting, notifications,
 *      installment workflow, agreement-completion, supersession compensation — is explicitly gated on
 *      specific OTHER statuses and correctly no-ops for "canceled"). `REFUND` (success:true) already
 *      reaches the pre-existing `"payment.refunded"` mapping the same way. `REFUND_FAILED`'s original
 *      Phase 1A claim here ("needs no new mapping — nothing to revert") was corrected in PHASE 1C
 *      below once a refund could actually finalize (reach "refunded") and THEN fail. `REFUNDED_REVERSED`
 *      (an already-CONFIRMED refund later reversing) is recognized as its own explicit case in
 *      `mapAdyenEventCode` (never silently merged into a generic "unknown eventCode" bucket) — see
 *      PHASE 1B CORRECTIONS below for how it is now mapped, and PHASE 1C for its ledger correction.
 *
 *   4. WEBHOOK/API CLEANUP:
 *      - The Phase 1 claim that "the Adyen webhook subscription must be configured for one
 *        notification item per HTTP POST in the Customer Area" is RETRACTED — it overstated a
 *        specific Adyen-side configuration option this file cannot confirm exists. The actual
 *        behavior is unchanged and remains safe either way: this adapter still requires exactly one
 *        `notificationItems` entry and fails closed (rejects, zero mutation) on a batch of more than
 *        one, but that is now documented as this integration's own current limitation (full
 *        multi-item-per-POST support is a disclosed follow-up), not a required Adyen reconfiguration.
 *        Adyen's own webhook redelivery/retry behavior bounds the practical impact.
 *      - Processor fee "unknown" is no longer represented as a real `$0`: `processorFeeMinorUnits`/
 *        `platformFeeMinorUnits` in parsed webhook event `data` are now `null` (genuinely unknown —
 *        Adyen's standard notifications do not report Adyen's own per-transaction fee) rather than a
 *        literal `0`. Downstream (`PaymentWebhookService.postLedgerEntryRequired`, unchanged, out of
 *        this phase's scope) already treats a non-number here as "no fee evidence to compare/assert,"
 *        and separately, deliberately defaults its OWN internal ledger posting to 0 — that fallback is
 *        Paid2You's own internal accounting decision, not a claim about what Adyen actually charged,
 *        and was already correctly distinguished in that file before this change.
 *
 * PHASE 1B CORRECTIONS, per a further follow-up review:
 *
 *   1. REFUNDED_REVERSED is now mapped (was deliberately left unmapped in Phase 1A — that write-up's
 *      concern about re-entering `PaymentWebhookService`'s success-effect/supersession machinery is
 *      resolved by mapping to a genuinely NEW, distinct terminal `PaymentAttemptStatus` —
 *      `"refund_reversed"` — never a reuse of `"succeeded"`. See `mapAdyenEventCode`'s
 *      `REFUNDED_REVERSED` case, `paymentService.ts`'s `ALLOWED_SOURCE_STATUSES_FOR_DESTINATION`
 *      (`refund_reversed: ["refunded"]`, itself with no legal outgoing transition — a permanent
 *      terminal correction, matching `"reversed"`/`"disputed"`/`"returned"`'s own shape), and
 *      `paymentWebhookService.ts`'s `EVENT_TYPE_TO_STATUS` entry for `"payment.refund_reversed"`,
 *      whose own doc comment records the by-inspection verification that every existing side-effect
 *      gate in that file correctly no-ops for this status. A second/duplicate/out-of-order
 *      REFUNDED_REVERSED delivery is rejected for free by the ordinary durable event-dedup +
 *      illegal-transition machinery every other event type already relies on — no new mechanism.
 *      `success:false` (Adyen attempted the reversal and could not) maps to `null` — the refund
 *      correctly remains "refunded".
 *
 *   2. UNKNOWN PROCESSOR FEE, remaining `provider_lookup` path: `FailedPaymentRetryCoordinator`'s
 *      `createPayment`-based idempotency-replay fallback (Phase 1A blocker 2) no longer fabricates
 *      `feeMinorUnits: 0` when Adyen genuinely does not report a fee at that lookup layer.
 *      `RetrievePaymentResult.feeMinorUnits` (paymentProvider.ts) now accepts `number | null`, and
 *      `PaymentWebhookService.postLedgerEntryRequired`'s `source: "provider_lookup"` evidence gate
 *      accepts an explicit `null` as valid "disclosed known-unknown" evidence (distinct from
 *      `undefined`/a malformed value, which remains rejected) — the smallest validation change that
 *      lets this path stop inventing a fake `$0` instead of widening the interface further or
 *      redesigning the evidence gate.
 *
 * PHASE 1C CORRECTIONS — refund-finality/accounting gap, per a further follow-up review:
 *
 *   1. REFUND_FAILED is now mapped. Verified against Adyen's own published refund-webhook
 *      documentation (docs.adyen.com/online-payments/refund) that REFUND_FAILED fires ONLY after an
 *      earlier REFUND webhook with success:true (a later card-scheme/bank-level rejection of an
 *      already-accepted refund — "although rare... can happen even a few days after you submit the
 *      refund request") — never as the very first/only refund outcome; an immediate/synchronous
 *      refund rejection is a REFUND webhook with success:false instead (Phase 1A/1B's own prior belief
 *      that REFUND_FAILED covered this case was wrong — corrected in `mapAdyenEventCode`'s "REFUND"
 *      case comment too). Maps to its own distinct terminal `PaymentAttemptStatus` —
 *      `"refund_failed"` — never a reuse of `"succeeded"` (same rationale as "refund_reversed" in
 *      Phase 1B), and kept separate FROM "refund_reversed" too (different real-world cause: scheme
 *      rejection vs. funds returned after settlement — worth keeping distinctly auditable), despite
 *      both driving the identical ledger correction. Reachable ONLY from "refunded"
 *      (`refund_failed: ["refunded"]`) — matches "refund_reversed"'s own identical terminal shape, so
 *      duplicate/out-of-order delivery is rejected for free by the same illegal-transition machinery.
 *
 *   2. REFUNDED_REVERSED's ledger effect — Phase 1B's own disclosed follow-up ("reversing the
 *      ORIGINAL refund's own ledger entry... not attempted here") is now closed. Both REFUND_FAILED
 *      and REFUNDED_REVERSED route through `PaymentWebhookService.postLedgerEntryRequired` to the same
 *      new `LedgerService.correctRefund` — which flips the EXISTING `refund` journal entry's own
 *      postings (the exact general inverse, regardless of whether that entry used the pre- or
 *      post-payout shape) and posts it as a new, idempotent-per-payment `refund_correction` entry.
 *      Never re-enters `postPaymentCleared` or `reversePayment` — no principal/fee/settlement entry is
 *      ever duplicated, only this one new correction, posted at most once per payment
 *      (`(paymentAttemptId, "refund_correction")` get-or-post, identical idempotency shape to every
 *      other automatic ledger entry type).
 *
 * PHASE 2 — bank-account collection/tokenization (this file's own portion of it):
 *
 *   1. `createBankAccountSession`/`disableStoredPaymentMethod` replace
 *      `linkBankAccount`/`tokenizeBankAccount`/`createPaymentMethodToken` as the live bank-account
 *      flow — see `CreateBankAccountSessionInput`'s own doc comment (paymentProvider.ts) for the full
 *      rationale. `createBankAccountSession` calls Adyen's Sessions API (`POST /sessions`) with
 *      `amount: {value: 0, currency: "USD"}` + `storePaymentMethodMode: "enabled"` — a genuinely
 *      documented Adyen pattern ("you can tokenize your shopper's payment details... with a
 *      zero-value auth") — never a live/real payment amount; the resulting session lets the CLIENT's
 *      own Adyen Web Component (`type: "ach"`) collect and submit the bank account details DIRECTLY
 *      to Adyen, never through this server. This adapter never learns or handles raw bank details at
 *      any point in this flow. PHASE 2A: zero-value ACH authorization is CONFIRMED (Adyen's own
 *      published help-center guidance) to require Adyen Support Team activation on the merchant
 *      account, together with GIACT verification — this is an EXTERNAL, account-level capability this
 *      codebase cannot verify or activate; see `getBankConnectionService.ts`'s own
 *      `ADYEN_ACH_TOKENIZATION_VERIFIED` gate, which keeps bank-linking unavailable until an operator
 *      explicitly confirms this activation with Adyen — never assumed, never silently enabled.
 *
 *   2. `disableStoredPaymentMethod` (`DELETE /storedPaymentMethods/{id}`) makes a token permanently
 *      unusable; its documented idempotency (disabling twice is not an error) is a CALLER-level
 *      contract (`RelationshipFinancialAccountService` checks local status before ever calling this),
 *      not a claim about Adyen's own DELETE response for an already-disabled id, which this pass could
 *      not independently confirm — a genuine 4xx/5xx from Adyen still surfaces as a real error here,
 *      never silently swallowed.
 *
 *   3. Token-lifecycle sync (`recurring.token.created`/`recurring.token.alreadyExisting`/
 *      `recurring.token.disabled`) uses a SEPARATE Adyen webhook subscription ("Recurring tokens life
 *      cycle events") from the Standard notifications subscription `verifyWebhookSignature`/
 *      `parseWebhookEvent` above handle — confirmed via Adyen's own published HMAC-validation guidance
 *      that this webhook family signs differently: the HMAC lives in an HTTP header (`hmacsignature`,
 *      with a `protocol` header confirming `HmacSHA256`), computed over the RAW, unparsed request
 *      body — never embedded in the JSON body the way Standard notifications work. See
 *      `verifyTokenLifecycleWebhookSignature`/`parseTokenLifecycleWebhookEvent` below, and
 *      `AdyenPaymentProviderConfig.recurringHmacKey` (a separate secret from `hmacKey`, exactly like
 *      `hmacKey` is itself already documented as distinct from any future Balance Platform webhook
 *      key). Routed through its own dedicated endpoint (`/api/payments/webhook/tokens`), never the
 *      existing Standard-notifications route, since the two families are verified in structurally
 *      different ways.
 *
 * PHASE 2A CORRECTION (final bank-security correction) — REMOVES the before/after stored-token
 * list-difference mechanism (`listStoredPaymentMethods` no longer exists on this class or the
 * `PaymentProvider` interface) and replaces it with a webhook-only, Adyen-authenticated correlation
 * chain — see `src/db/schema/bankLinkAttempt.ts`'s own doc comment for the complete design:
 *
 *   1. `createBankAccountSession` now requires the CALLER to supply `merchantReference` (never
 *      generated internally) — this becomes the Adyen `reference` field on the `/sessions` request,
 *      which Adyen echoes back verbatim as `merchantReference` on the resulting transaction's own
 *      Standard AUTHORISATION webhook (`parseWebhookEvent`'s returned `data.merchantReference` below
 *      — a NEW field this correction adds; previously silently dropped).
 *   2. `parseTokenLifecycleWebhookEvent` now additionally returns `merchantAccount` and `pspReference`
 *      (Adyen's own `eventId` field — documented as "the pspReference of the event that triggered the
 *      webhook", i.e. the SAME pspReference as the originating AUTHORISATION transaction) — both
 *      REQUIRED, together with `shopperReference`, for `BankConnectionService`'s own correlation
 *      lookup against the `bank_link_attempt` row's `confirmedPspReference` (set only once the
 *      matching AUTHORISATION webhook was independently, durably processed). Verified via Adyen's own
 *      published tokenization-webhook field documentation — never invented.
 */

const CHECKOUT_API_VERSION = "v72";

export interface AdyenPaymentProviderConfig {
  apiKey: string;
  merchantAccount: string;
  /** The account-specific live URL prefix from Adyen's Customer Area (Developers > API URLs > Prefix) — never a shared/generic host. */
  liveUrlPrefix: string;
  /** Base64-encoded HMAC key from the Adyen webhook subscription's "Additional settings" (Standard notifications, payments-webhook HMAC — distinct from any future Balance Platform webhook HMAC key). */
  hmacKey: string;
  /**
   * PAID2YOU — B0-D ADYEN PHASE 2: HMAC key for the SEPARATE "Recurring tokens life cycle events"
   * webhook subscription — never the same value as `hmacKey` above (a distinct Adyen webhook
   * subscription, its own independently-generated key). Optional at this type level (mirroring every
   * other provider secret's "optional at the schema level, enforced at the point of use" convention —
   * see src/config/env.ts) — `verifyTokenLifecycleWebhookSignature` fails closed (returns `false`,
   * never verifies) when it is absent, rather than requiring it for the entire provider to construct.
   */
  recurringHmacKey?: string;
}

interface AdyenErrorResponse {
  status?: number;
  errorCode?: string;
  errorType?: string;
  message?: string;
}

/** PAID2YOU — B0-D ADYEN PHASE 2A: see `AdyenPaymentProvider.parseTokenLifecycleWebhookEvent`'s own doc comment. */
export interface AdyenTokenLifecycleEvent {
  eventType: string;
  /** The originating transaction's own pspReference (Adyen's `eventId` field) — matched against `bank_link_attempt.confirmedPspReference`. */
  pspReference: string;
  storedPaymentMethodId: string;
  shopperReference: string;
  merchantAccount: string;
}

interface AdyenPaymentsResponse {
  pspReference?: string;
  resultCode?: string;
  refusalReason?: string;
}

interface AdyenModificationResponse {
  pspReference?: string;
  status?: string;
}

interface AdyenSessionsResponse {
  id?: string;
  sessionData?: string;
}

export interface AdyenNotificationRequestItem {
  additionalData?: { hmacSignature?: string };
  amount?: { value?: number; currency?: string };
  eventCode?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  originalReference?: string;
  paymentMethod?: string;
  pspReference?: string;
  reason?: string;
  success?: string;
}

interface AdyenNotificationRequest {
  notificationItems?: Array<{ NotificationRequestItem: AdyenNotificationRequestItem }>;
}

/**
 * Adyen's documented HMAC field-escaping rule: backslash escaped first, then colon (order matters —
 * escaping colon first would double-escape a backslash inserted by the first pass). Exported (along
 * with the other pure helpers below) so this file's own tests can verify the signing-string
 * construction directly against Adyen's own published example, independent of any mocked network call.
 */
export function escapeHmacField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

export function computeAdyenHmac(hmacKeyBase64: string, signingString: string): string {
  const keyBuffer = Buffer.from(hmacKeyBase64, "base64");
  return createHmac("sha256", keyBuffer).update(signingString, "utf8").digest("base64");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Adyen's own field order for the payments-webhook HMAC. */
export function buildHmacSigningString(item: AdyenNotificationRequestItem): string {
  const fields = [
    item.pspReference ?? "",
    item.originalReference ?? "",
    item.merchantAccountCode ?? "",
    item.merchantReference ?? "",
    item.amount?.value !== undefined ? String(item.amount.value) : "",
    item.amount?.currency ?? "",
    item.eventCode ?? "",
    item.success ?? "",
  ];
  return fields.map(escapeHmacField).join(":");
}

/**
 * Which internal Paid2You event type (if any) a given Adyen eventCode+success maps to. Never forces a
 * mapping that does not exist — see this file's module doc comment, Phase 1A item 3 for CANCELLATION's
 * exact reasoning, Phase 1B item 1 for REFUNDED_REVERSED's, and Phase 1C item 1 for REFUND_FAILED's.
 */
export function mapAdyenEventCode(eventCode: string, success: boolean): string | null {
  switch (eventCode) {
    case "AUTHORISATION":
      return success ? "payment.succeeded" : "payment.failed";
    case "CANCELLATION":
      // Phase 1A item 3: now mapped (was unmapped in Phase 1) — safe because cancel/refund no longer
      // finalize synchronously, so a payment reaching this webhook is still legitimately "pending".
      return success ? "payment.canceled" : null; // success:false -> no transition; correctly stays "pending".
    case "REFUND":
      // PAID2YOU — B0-D ADYEN PHASE 1C correction: Adyen's own docs confirm an IMMEDIATE/synchronous
      // refund rejection (Adyen's own validation failing before it ever reaches the card scheme —
      // e.g. "refund amount too high") is reported as a REFUND webhook with success:false itself, NOT
      // REFUND_FAILED (verified against docs.adyen.com/online-payments/refund — Phase 1A's own prior
      // comment here was wrong on this point). success:false correctly maps to no transition — the
      // payment never reached "refunded" in the first place, so there is nothing to revert.
      return success ? "payment.refunded" : null;
    case "REFUND_FAILED":
      // PAID2YOU — B0-D ADYEN PHASE 1C: now mapped (was deliberately unmapped in Phase 1A, under the
      // mistaken belief there was "nothing to revert"). Adyen's own docs confirm REFUND_FAILED fires
      // ONLY after an earlier REFUND webhook with success:true — a later card-scheme/bank-level
      // rejection of an already-accepted refund — and is always delivered with success:false itself
      // (there is no documented success:true case for this eventCode; one is fail-closed to no
      // mapping rather than guessed). See module doc comment, Phase 1C item 1.
      return success ? null : "payment.refund_failed";
    case "REFUNDED_REVERSED":
      // Phase 1B: now mapped to Paid2You's distinct "payment.refund_reversed" (was deliberately
      // unmapped in Phase 1A) — success:true means Adyen confirms the reversal; success:false means
      // Adyen attempted to reverse it and could not, so the refund correctly remains "refunded".
      return success ? "payment.refund_reversed" : null;
    case "CHARGEBACK":
      // ACH Direct Debit reversal, per Adyen's own docs — mapped to Paid2You's "returned" (ACH-specific),
      // never "reversed" (reserved for card/network chargebacks) — see module doc comment.
      return success ? "payment.returned" : null;
    case "CAPTURE": // not applicable to ACH Direct Debit in this phase (auto-captured).
    default:
      return null;
  }
}

export class AdyenPaymentProvider implements PaymentProvider {
  readonly providerName = "adyen";
  readonly providerEnvironment = "production" as const;

  constructor(private readonly config: AdyenPaymentProviderConfig) {}

  private checkoutBaseUrl(): string {
    return `https://${this.config.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/${CHECKOUT_API_VERSION}`;
  }

  /**
   * Phase 1A item 2: network-layer failures and 5xx responses are genuinely AMBIGUOUS (the request
   * may or may not have reached/been processed by Adyen) and throw `AmbiguousProviderResponseError`
   * — never a plain `ValidationError` — so callers built around that distinction (specifically
   * `FailedPaymentRetryCoordinator`) handle them correctly instead of misclassifying them as a
   * definite rejection. A 4xx response means Adyen definitively received and rejected the request
   * itself (bad API key, malformed body, etc.) — a real, non-ambiguous `ValidationError`.
   */
  private async request<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.checkoutBaseUrl()}${path}`, {
        method: "POST",
        headers: {
          "X-API-Key": this.config.apiKey,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new AmbiguousProviderResponseError(
        `Adyen request to ${path} failed at the network layer (may or may not have reached Adyen): ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
    const json = (await response.json().catch(() => null)) as (T & AdyenErrorResponse) | null;
    if (!response.ok) {
      // Never surface the raw response body — Adyen's own errorCode/errorType are safe, standardized
      // diagnostic codes; the rest of the body may echo shopper-identifying request detail.
      const detail = `Adyen request to ${path} failed (HTTP ${response.status}${json?.errorCode ? `, errorCode ${json.errorCode}` : ""}).`;
      if (response.status >= 500) {
        throw new AmbiguousProviderResponseError(`${detail} A 5xx response means Adyen's own outcome is unknown, not a definite rejection.`);
      }
      throw new ValidationError(detail);
    }
    if (!json) {
      throw new ValidationError(`Adyen request to ${path} returned an unparseable response.`);
    }
    return json;
  }

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2: DELETE variant — no body, no parsed-response return value. Any 2xx
   * is treated as success; a genuine 4xx/5xx still surfaces as a real error (never silently
   * swallowed) — see module doc comment, Phase 2 item 2, for why this method itself does not attempt
   * to special-case "already disabled" as a fabricated success.
   */
  private async requestDelete(path: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.checkoutBaseUrl()}${path}`, {
        method: "DELETE",
        headers: { "X-API-Key": this.config.apiKey, "Content-Type": "application/json" },
      });
    } catch (error) {
      throw new AmbiguousProviderResponseError(
        `Adyen DELETE request to ${path} failed at the network layer (may or may not have reached Adyen): ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
    if (response.ok) return;
    const json = (await response.json().catch(() => null)) as AdyenErrorResponse | null;
    const detail = `Adyen DELETE request to ${path} failed (HTTP ${response.status}${json?.errorCode ? `, errorCode ${json.errorCode}` : ""}).`;
    if (response.status >= 500) {
      throw new AmbiguousProviderResponseError(`${detail} A 5xx response means Adyen's own outcome is unknown, not a definite rejection.`);
    }
    throw new ValidationError(detail);
  }

  /** Fails closed (returns null) on anything but exactly one notification item — never silently processes only the first of a batch. See module doc comment, Phase 1A item 4. */
  private extractSingleNotificationItem(rawBody: string): AdyenNotificationRequestItem | null {
    let parsed: AdyenNotificationRequest;
    try {
      parsed = JSON.parse(rawBody) as AdyenNotificationRequest;
    } catch {
      return null;
    }
    const items = parsed.notificationItems;
    if (!Array.isArray(items) || items.length !== 1) return null;
    return items[0]?.NotificationRequestItem ?? null;
  }

  // ---------------------------------------------------------------------------------------------
  // Implemented this phase.
  // ---------------------------------------------------------------------------------------------

  /** See module doc comment, Phase 1A item 1: requires the EXACT provider payment-method reference — never looks one up or guesses. */
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!Number.isInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
      throw new ValidationError("amountMinorUnits must be a positive integer.");
    }
    if (input.currency !== "USD") {
      throw new ValidationError("AdyenPaymentProvider (B0-D Phase 1) only supports USD — ACH Direct Debit is a US-only rail.");
    }
    if (!input.providerPaymentMethodRef || input.providerPaymentMethodRef.trim().length === 0) {
      throw new ValidationError(
        "AdyenPaymentProvider.createPayment requires an exact providerPaymentMethodRef (Adyen storedPaymentMethodId) — none was supplied. Refusing to look one up or guess.",
      );
    }
    const storedPaymentMethodId = input.providerPaymentMethodRef;
    const shopperReference = this.deriveShopperReference(input.payer);

    const body = {
      merchantAccount: this.config.merchantAccount,
      reference: input.idempotencyKey,
      amount: { value: input.amountMinorUnits, currency: input.currency },
      paymentMethod: { type: "ach", storedPaymentMethodId },
      shopperReference,
      shopperInteraction: "ContAuth",
      recurringProcessingModel: "Subscription",
    };
    const response = await this.request<AdyenPaymentsResponse>("/payments", body, input.idempotencyKey);
    const pspReference = response.pspReference;
    if (!pspReference) {
      throw new ValidationError("Adyen /payments response did not include a pspReference.");
    }
    return { providerPaymentId: pspReference, status: this.resolveSyncStatus(response.resultCode) };
  }

  private resolveSyncStatus(resultCode: string | undefined): PaymentProviderPaymentStatus {
    switch (resultCode) {
      case "Authorised":
        return "succeeded";
      case "Refused":
      case "Error":
        return "failed";
      default:
        // ACH Direct Debit's normal synchronous result ("Received"/"Pending") — the asynchronous
        // AUTHORISATION webhook remains the authoritative success/fail signal, exactly matching how
        // the retired sandbox's own "pending, then webhook resolves it" model already worked.
        return "pending";
    }
  }

  /** PAID2YOU — B0-D ADYEN PHASE 2: pure, synchronous — see `PaymentProvider.deriveShopperReference`'s own doc comment for why this exact derivation must never drift between tokenization and charging. */
  deriveShopperReference(profile: ProfileRef): string {
    return `${profile.profileKind}:${profile.profileId}`;
  }

  /**
   * See module doc comment, Phase 2 item 1 and PHASE 2A CORRECTION item 1. `input.merchantReference`
   * (never generated internally anymore) becomes the Adyen `reference` field — the exact value an
   * incoming AUTHORISATION webhook's own `merchantReference` must echo back for
   * `BankConnectionService` to correlate it against the persisted `bank_link_attempt` row.
   */
  async createBankAccountSession(input: CreateBankAccountSessionInput): Promise<CreateBankAccountSessionResult> {
    if (!input.shopperReference.trim()) {
      throw new ValidationError("AdyenPaymentProvider.createBankAccountSession requires a non-empty shopperReference.");
    }
    if (!input.merchantReference.trim()) {
      throw new ValidationError("AdyenPaymentProvider.createBankAccountSession requires a non-empty merchantReference.");
    }
    const body = {
      merchantAccount: this.config.merchantAccount,
      reference: input.merchantReference,
      amount: { value: 0, currency: "USD" },
      countryCode: "US",
      shopperReference: input.shopperReference,
      shopperInteraction: "Ecommerce",
      recurringProcessingModel: "Subscription",
      storePaymentMethodMode: "enabled",
      returnUrl: input.returnUrl,
      allowedPaymentMethods: ["ach"],
    };
    const response = await this.request<AdyenSessionsResponse>("/sessions", body);
    if (!response.id || !response.sessionData) {
      throw new ValidationError("Adyen /sessions response did not include id/sessionData.");
    }
    return { providerSessionId: response.id, sessionData: response.sessionData };
  }

  /** See module doc comment, Phase 2 item 2 for why this method itself never special-cases "already disabled." */
  async disableStoredPaymentMethod(input: DisableStoredPaymentMethodInput): Promise<void> {
    if (!input.storedPaymentMethodId.trim() || !input.shopperReference.trim()) {
      throw new ValidationError("AdyenPaymentProvider.disableStoredPaymentMethod requires a non-empty storedPaymentMethodId and shopperReference.");
    }
    const query = new URLSearchParams({ shopperReference: input.shopperReference, merchantAccount: this.config.merchantAccount }).toString();
    await this.requestDelete(`/storedPaymentMethods/${encodeURIComponent(input.storedPaymentMethodId)}?${query}`);
  }

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2: verifies the SEPARATE "Recurring tokens life cycle events" webhook
   * family — see module doc comment, Phase 2 item 3, for exactly how this differs from
   * `verifyWebhookSignature` above (header-based HMAC over the raw body, not body-embedded). Fails
   * closed (`false`) whenever `recurringHmacKey` is not configured, the `protocol` header is anything
   * but the expected algorithm, or the header is missing — never partially verifies.
   */
  verifyTokenLifecycleWebhookSignature(rawBody: string, hmacSignatureHeader: string | null, protocolHeader: string | null): boolean {
    if (!this.config.recurringHmacKey) return false;
    if (!hmacSignatureHeader || protocolHeader !== "HmacSHA256") return false;
    const keyBuffer = Buffer.from(this.config.recurringHmacKey, "hex");
    const expected = createHmac("sha256", keyBuffer).update(rawBody, "utf8").digest("base64");
    return timingSafeEqualStrings(expected, hmacSignatureHeader);
  }

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2A: parses a "Recurring tokens life cycle events" webhook body — a
   * `{eventId, type, data: {merchantAccount, storedPaymentMethodId, shopperReference, ...}}` envelope,
   * structurally distinct from the `notificationItems` wrapper `parseWebhookEvent` above handles.
   * `pspReference` is taken from the TOP-LEVEL `eventId` field — Adyen's own documented "PSP reference
   * of the event that triggered the webhook" (i.e. the SAME pspReference as the originating
   * AUTHORISATION transaction) — the exact "originating transaction reference" this phase's
   * correlation chain matches against `bank_link_attempt.confirmedPspReference`. `merchantAccount` is
   * required so the caller can reject an event for a different merchant account outright. Returns
   * `null` (never throws, never fabricates a partial result) for anything not matching this exact,
   * fully-populated shape.
   */
  parseTokenLifecycleWebhookEvent(rawBody: string): AdyenTokenLifecycleEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const body = parsed as Record<string, unknown>;
    const eventType = body.type;
    const pspReference = body.eventId;
    const data = body.data;
    if (typeof eventType !== "string" || typeof pspReference !== "string" || !pspReference) return null;
    if (!data || typeof data !== "object") return null;
    const { storedPaymentMethodId, shopperReference, merchantAccount } = data as Record<string, unknown>;
    if (typeof storedPaymentMethodId !== "string" || !storedPaymentMethodId) return null;
    if (typeof shopperReference !== "string" || !shopperReference) return null;
    if (typeof merchantAccount !== "string" || !merchantAccount) return null;
    return { eventType, pspReference, storedPaymentMethodId, shopperReference, merchantAccount };
  }

  /** See module doc comment, Phase 1A item 3: returns whether Adyen ACCEPTED the cancellation request — never whether it is confirmed. `PaymentService.cancelPayment` must not treat this as final. */
  async cancelPayment(providerPaymentId: string): Promise<CancelPaymentResult> {
    try {
      await this.request<AdyenModificationResponse>(
        `/payments/${encodeURIComponent(providerPaymentId)}/cancels`,
        { merchantAccount: this.config.merchantAccount, reference: `cancel-${providerPaymentId}` },
        `cancel-${providerPaymentId}`,
      );
      return { canceled: true };
    } catch {
      return { canceled: false };
    }
  }

  /**
   * See module doc comment, Phase 1A item 3: returns whether Adyen ACCEPTED the refund request —
   * never whether it is confirmed. `PaymentService.refundPayment` must not treat this as final.
   *
   * PAID2YOU — B0-D ADYEN PHASE 1A (blocker 3 — cancel/refund finality, duplicate-request safety):
   * `reference`/`Idempotency-Key` are DETERMINISTIC (`refund-${providerPaymentId}`, no random
   * component) — not merely a cosmetic choice. Because `PaymentService.refundPayment` no longer
   * advances the local status on request-acceptance alone (it stays "succeeded" until the REFUND
   * webhook confirms it), a second `refundPayment` call for the SAME payment before that webhook
   * arrives would otherwise reach this method again with nothing locally distinguishing it from the
   * first. A deterministic key means Adyen's own real Idempotency-Key semantics (a repeated request
   * with the same key returns the ORIGINAL cached response) catches exactly this case — never a
   * second refund — the same protection `cancelPayment`'s own already-deterministic
   * `cancel-${providerPaymentId}` reference relies on.
   */
  async refundPayment(providerPaymentId: string, amountMinorUnits?: number): Promise<RefundPaymentResult> {
    if (amountMinorUnits !== undefined) {
      // PaymentProvider.refundPayment does not receive `currency`, and Adyen's /refunds endpoint
      // requires an explicit amount+currency together whenever a partial amount is given — cannot
      // safely guess currency. PaymentService.refundPayment (today's only caller) never passes a
      // partial amount, so this is not reachable in production today; still refuses rather than guess.
      throw new ValidationError("AdyenPaymentProvider.refundPayment does not support a partial amount in this phase — PaymentProvider.refundPayment's interface does not carry the currency a partial Adyen refund requires.");
    }
    const reference = `refund-${providerPaymentId}`;
    const response = await this.request<AdyenModificationResponse>(
      `/payments/${encodeURIComponent(providerPaymentId)}/refunds`,
      { merchantAccount: this.config.merchantAccount, reference },
      reference,
    );
    if (!response.pspReference) {
      throw new ValidationError("Adyen /refunds response did not include a pspReference.");
    }
    return { providerRefundId: response.pspReference };
  }

  /** HMAC is embedded in the JSON body (additionalData.hmacSignature), never a header — `_signatureHeader` is accepted only to satisfy PaymentProvider's unchanged interface shape and is otherwise unused. Fails closed (false) on anything but exactly one notification item. */
  verifyWebhookSignature(rawBody: string, _signatureHeader: string): boolean {
    const item = this.extractSingleNotificationItem(rawBody);
    if (!item) return false;
    const hmacSignature = item.additionalData?.hmacSignature;
    if (!hmacSignature) return false;
    const expected = computeAdyenHmac(this.config.hmacKey, buildHmacSigningString(item));
    return timingSafeEqualStrings(expected, hmacSignature);
  }

  parseWebhookEvent(rawBody: string): ParsedWebhookEvent {
    const item = this.extractSingleNotificationItem(rawBody);
    if (!item) {
      throw new ValidationError(
        "Adyen webhook payload must contain exactly one notificationItems entry — this integration does not yet support multiple notification items per HTTP POST (see module doc comment, Phase 1A item 4).",
      );
    }
    const eventCode = item.eventCode;
    const pspReference = item.pspReference;
    if (!eventCode || !pspReference) {
      throw new ValidationError("Adyen webhook payload is missing eventCode/pspReference.");
    }
    const success = item.success === "true";
    const eventType = mapAdyenEventCode(eventCode, success);
    // AUTHORISATION's own pspReference IS the original payment's identity; every modification event
    // (CANCELLATION/REFUND/REFUND_FAILED/REFUNDED_REVERSED/CHARGEBACK) carries the ORIGINAL payment's
    // reference in originalReference instead — its own pspReference identifies the modification.
    const providerPaymentId = eventCode === "AUTHORISATION" ? pspReference : item.originalReference || pspReference;

    const data: Record<string, unknown> = {
      providerPaymentId,
      pspReference,
      // PAID2YOU — B0-D ADYEN PHASE 2A: previously silently dropped — this is the correlation key
      // `BankConnectionService` matches an AUTHORISATION event against a `bank_link_attempt` row's own
      // `merchantReference` (see module doc comment, PHASE 2A CORRECTION item 1). Also present, and
      // simply unused, for every ordinary payment event — no behavior change there.
      merchantReference: item.merchantReference ?? null,
      merchantAccountCode: item.merchantAccountCode ?? null,
      success,
      amountMinorUnits: item.amount?.value,
      currency: item.amount?.currency,
      // Phase 1A item 4: genuinely unknown (Adyen's standard notifications carry no per-transaction
      // fee), represented as `null` — never a real `0` — see module doc comment.
      processorFeeMinorUnits: null,
      platformFeeMinorUnits: null,
      ...(eventType === "payment.failed" ? { failureCategory: item.reason ?? "adyen_declined" } : {}),
    };

    return {
      provider: this.providerName,
      // Adyen does not issue a separate notification id distinct from (pspReference, eventCode,
      // success) — this composite is the standard integrator-level deduplication identity.
      providerEventId: `${pspReference}:${eventCode}:${item.success ?? ""}`,
      // An eventCode this phase does not map to any Paid2You status is reported as a distinct,
      // deliberately-unrecognized eventType — PaymentWebhookService's own existing "unrecognized event
      // type" path safely no-ops on it, never a fabricated mapping.
      eventType: eventType ?? `adyen.unmapped.${eventCode.toLowerCase()}`,
      data,
    };
  }

  /** Test/signing helper — mirrors SandboxPaymentProvider's identical "produces a signature a real caller would send" precedent, used only by this file's own tests to construct a validly-signed fixture notification. */
  signWebhookPayloadForTest(item: AdyenNotificationRequestItem): string {
    return computeAdyenHmac(this.config.hmacKey, buildHmacSigningString(item));
  }

  // ---------------------------------------------------------------------------------------------
  // Deliberately NOT implemented this phase (later B0-D phases) — see module doc comment.
  // ---------------------------------------------------------------------------------------------

  async createRecipientAccount(_input: CreateRecipientAccountInput): Promise<CreateRecipientAccountResult> {
    throw new Error(
      "AdyenPaymentProvider.createRecipientAccount is not implemented in B0-D Adyen Phase 1 — recipient/payout accounts require Balance Platform + Legal Entity Management + the Transfers API, a later B0-D phase, not the Payments API foundation this phase covers.",
    );
  }

  // PAID2YOU — B0-D ADYEN PHASE 2 (updated PHASE 2A): these three are now SUPERSEDED, not merely
  // "not yet implemented" — `createBankAccountSession`/`disableStoredPaymentMethod` above, plus the
  // webhook-only correlation chain in `BankConnectionService`, are the live bank-account flow (see
  // module doc comment). Still throw, deliberately never implemented against Adyen for real:
  // implementing `tokenizeBankAccount` for real would require raw bank credentials to reach THIS
  // SERVER, exactly the architecture Phase 2/2A replaces. Retained only so this class keeps satisfying
  // `PaymentProvider`'s full interface shape.
  async linkBankAccount(_input: LinkBankAccountInput): Promise<LinkBankAccountResult> {
    throw new Error("AdyenPaymentProvider.linkBankAccount is superseded by createBankAccountSession (B0-D Adyen Phase 2/2A) — see createRecipientAccount's identical note.");
  }

  async tokenizeBankAccount(_input: TokenizeBankAccountInput): Promise<TokenizeBankAccountResult> {
    throw new Error(
      "AdyenPaymentProvider.tokenizeBankAccount is superseded by createBankAccountSession (B0-D Adyen Phase 2/2A) — implementing this for real would require raw bank credentials to reach this server, which Phase 2 exists specifically to avoid.",
    );
  }

  async createPaymentMethodToken(_input: CreatePaymentMethodTokenInput): Promise<CreatePaymentMethodTokenResult> {
    throw new Error("AdyenPaymentProvider.createPaymentMethodToken is superseded by createBankAccountSession (B0-D Adyen Phase 2/2A) — see tokenizeBankAccount's identical note.");
  }

  /** Phase 1A item 2: now a specifically-typed `ProviderCapabilityUnsupportedError` — see module doc comment. */
  async retrievePayment(providerPaymentId: string): Promise<RetrievePaymentResult> {
    throw new ProviderCapabilityUnsupportedError(
      `AdyenPaymentProvider.retrievePayment is not implementable against Adyen's Checkout API: there is no GET-by-pspReference endpoint (Adyen's documented model is webhook-driven status, not polling). Cannot look up "${providerPaymentId}" synchronously.`,
    );
  }

  /** Phase 1A item 2: now a specifically-typed `ProviderCapabilityUnsupportedError` — no caller in this codebase invokes this anymore (see FailedPaymentRetryCoordinator's own Phase 1A rewrite), retained only as a safe, typed refusal for any future caller. */
  async retrievePaymentByIdempotencyKey(idempotencyKey: string): Promise<RetrievePaymentResult | null> {
    throw new ProviderCapabilityUnsupportedError(
      `AdyenPaymentProvider.retrievePaymentByIdempotencyKey cannot be resolved from only an idempotency key ("${idempotencyKey}"): Adyen's idempotency-key replay requires re-POSTing the exact ORIGINAL /payments request body, which this interface method's signature does not provide.`,
    );
  }
}
