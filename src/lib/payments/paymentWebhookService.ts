import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ConfigurationError, ForbiddenError, ValidationError } from "@/lib/errors";
import { FinancialIntegrityError, type LedgerService } from "@/lib/ledger/ledgerService";
import { logger } from "@/lib/logger";
import type { NotificationEventType } from "@/lib/notify/eventTypes";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { RiskEventService } from "@/lib/risk/riskEventService";
import type { PaymentProvider } from "./paymentProvider";
import { DefaultPlatformFeePolicy, type PlatformFeePolicy } from "./platformFeePolicy";
import {
  ALLOWED_SOURCE_STATUSES_FOR_DESTINATION,
  isTransitionPermanentlyIllegal,
  type AgreementCompletionChecker,
  type PaymentAttemptRecord,
  type PaymentAttemptRepository,
  type PaymentAttemptStatus,
} from "./paymentService";
import type { PaymentTransitionCoordinator } from "./paymentTransitionCoordinator";

export type PaymentWebhookProcessingStatus = "received" | "processing" | "processed" | "failed";

/** PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1): see `ConflictExceptionRecorder`'s own doc comment. */
export type ConflictExceptionType =
  | "amount_mismatch"
  | "currency_mismatch"
  | "processor_fee_mismatch"
  | "platform_fee_mismatch"
  | "status_mismatch"
  | "provider_identity_mismatch";

/**
 * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1 — AUTOMATIC CONFLICT
 * DETECTION + CONFLICT EXCEPTION IDEMPOTENCY): the narrow conflict-recording capability
 * `PaymentWebhookService` needs to make a materially conflicting trusted financial event's evidence
 * automatically observable, DURING normal event processing — never requiring a separate, manually-
 * triggered reconciliation scan. Structurally satisfied by
 * `DrizzleReconciliationExceptionRepository`/`ReconciliationExceptionRepository` (see
 * reconciliationService.ts's own doc comments); declared narrowly here, not imported from that
 * module, so this module never depends on the full reconciliation domain for one small capability.
 *
 * `ensureOpenException` — NOT a "find open then insert" pair — is the sanctioned idempotency
 * mechanism: it must be backed by a real DB uniqueness constraint (a partial unique index on
 * `(payment_attempt_id, provider_event_id, exception_type) WHERE status = 'open'`) plus
 * `INSERT ... ON CONFLICT DO NOTHING`, so two genuinely concurrent detections of the SAME conflicting
 * event can never race their way into two open exceptions — the database itself is the sole source of
 * truth for "does an open one already exist," never a separate read followed by a separate write.
 */
export interface ConflictExceptionRecorder {
  ensureOpenException(input: {
    exceptionType: ConflictExceptionType;
    paymentAttemptId: string;
    providerEventId: string;
    details: unknown;
  }): Promise<{ id: string } | null>;
}

/** PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Part A): see `PaymentWebhookEventRecord.source`'s own doc comment. */
export type PaymentWebhookEventSource = "webhook" | "provider_lookup";

export interface PaymentWebhookEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Part A): the TRUTHFUL origin
   * of this row — see `paymentWebhookEventSourceEnum`'s own schema doc comment for the full model.
   * "webhook" = genuinely arrived via `receiveWebhook` (an inbound provider delivery);
   * "provider_lookup" = genuinely originated from `receiveInternalEvent`, reachable ONLY from
   * `FailedPaymentRetryCoordinator.resolveAmbiguousRetry`'s own authenticated provider lookup, never
   * from any HTTP/user-controlled route. Never overload `signatureVerified` to mean "trusted somehow"
   * — that field means one narrow thing (an inbound request's signature was cryptographically
   * verified) and is meaningless for a row that was never an inbound HTTP request at all.
   */
  source: PaymentWebhookEventSource;
  signatureVerified: boolean;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
  processingStatus: PaymentWebhookProcessingStatus;
  processingAttempts: number;
  processingStartedAt: Date | null;
  lastFailedAt: Date | null;
  lastErrorCode: string | null;
  nextRetryAt: Date | null;
  leaseExpiresAt: Date | null;
  /**
   * R09 corrective pass (Codex blocker 2 — claim fencing): a fresh UUID minted every time this row is
   * claimed or reclaimed (`tryInsertAndClaim`/`claimExistingForProcessing`/`claimBatchForRecovery`).
   * Every finalization call (`markProcessed`/`markFailedRetryable`/`markFailedPermanent`) must present
   * the exact token it was handed at claim time; the repository WHERE-guards on it, so a worker whose
   * lease already expired and was reclaimed by someone else always finalizes against a token that no
   * longer matches the row — a guaranteed no-op, never an overwrite of the new owner's outcome. Never
   * rely on `leaseExpiresAt`/timestamps alone to decide ownership — this token is the sole authority.
   * Nullable only because rows written before this column existed have no token until first reclaimed.
   */
  claimToken: string | null;
  /**
   * R09 corrective pass (Codex blocker 8 — reconciliation evidence): extracted from the trusted
   * payload at claim time so `findTrustedFinancialEventsForPayment` can look it up via an index
   * instead of scanning/deserializing every row's payload.
   */
  providerPaymentId: string | null;
  /**
   * PACKAGE B — remaining Codex blockers (durable provider-event transition progress): null until
   * `PaymentTransitionCoordinator.applyTransition` durably records that THIS EXACT event's own
   * payment-status transition actually applied. See that class's own doc comment for the full defect
   * this closes and why current payment status alone can never answer this question on retry. Null
   * for every historical/pre-existing row (including one already marked "processed" under the old
   * model) — those predate this guarantee and are never assumed to have completed every required
   * effect merely because of that; see the migration's own doc comment.
   */
  transitionAppliedAt: Date | null;
  /** Set together with `transitionAppliedAt`, from the same atomic write — the exact transition this event caused, never inferred from current status. */
  transitionFromStatus: PaymentAttemptStatus | null;
  transitionToStatus: PaymentAttemptStatus | null;
}

export type ClaimOutcome =
  | { outcome: "claimed"; record: PaymentWebhookEventRecord }
  /** processingStatus === "processed" — fully, durably completed. Never reprocess. */
  | { outcome: "duplicate" }
  /** processingStatus === "processing" with an unexpired lease — another worker owns it right now. */
  | { outcome: "in_progress" }
  /** Retryable-failed but its backoff hasn't elapsed yet, OR permanently failed (poison) — not eligible right now either way. */
  | { outcome: "not_due" };

/**
 * R06 (webhook processed-state / redelivery recovery) — corrective pass. Root cause this interface
 * exists to close: the pre-remediation flow was `find by (provider, providerEventId) -> if found,
 * "duplicate" -> else insert -> apply effects -> markProcessed`. A crash (or any uncaught error)
 * between "insert" and "markProcessed" left a row that looked, to every later redelivery, identical
 * to one that legitimately hadn't been retried yet — but the very next delivery of that exact event
 * would find the row and short-circuit to "duplicate", NEVER actually applying it. Event existence
 * was being treated as proof of event completion; it never was.
 *
 * The fix: every insert immediately, atomically claims the row for processing (see
 * `tryInsertAndClaim`); every later contact with an already-existing row goes through
 * `claimExistingForProcessing`, an authoritative, DB-enforced state check — never a plain read
 * followed by a separate write. `processingStatus` (see its own type's doc comment) is the single
 * durable source of truth for "was this merely received, is it currently owned by a live worker, did
 * it complete, or did it fail" — `processedAt` is kept only for backward-compatible reads.
 */
export interface PaymentWebhookEventRepository {
  findByProviderEvent(provider: string, providerEventId: string): Promise<PaymentWebhookEventRecord | null>;
  /**
   * Attempts to insert a brand-new event, ALREADY claimed for processing in the same statement
   * (`processingStatus: "processing"`, `processingAttempts: 1`, a fresh lease) — there is no window
   * between "recorded" and "claimed" for a crash to hide in. Returns `null` on a `(provider,
   * providerEventId)` unique-constraint conflict (a genuinely concurrent or redelivered event); the
   * caller must then fall back to `claimExistingForProcessing`.
   */
  tryInsertAndClaim(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    /** PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Part A): required, never defaulted — every caller must explicitly decide the row's true origin. See `PaymentWebhookEventRecord.source`'s own doc comment. */
    source: PaymentWebhookEventSource;
    signatureVerified: boolean;
    payload: unknown;
    leaseMs: number;
    now: Date;
  }): Promise<PaymentWebhookEventRecord | null>;
  /**
   * Atomically decides whether an EXISTING row is safe to (re)claim right now, and claims it in the
   * same transaction if so — never a plain read-then-write. See `ClaimOutcome`'s own doc comments for
   * the exact decision table (processed -> duplicate; live lease -> in_progress; backoff not yet due,
   * or permanently failed -> not_due; otherwise -> claimed with a fresh lease and an incremented
   * attempt count).
   */
  claimExistingForProcessing(provider: string, providerEventId: string, leaseMs: number, now: Date): Promise<ClaimOutcome>;
  /**
   * R06 recovery scheduler entry point: atomically claims up to `limit` eligible rows system-wide
   * (received, retry-due, or lease-expired) in one transaction, using `SELECT ... FOR UPDATE SKIP
   * LOCKED` so multiple simultaneous scheduler instances can run safely without claiming the same
   * row twice or blocking on each other.
   */
  claimBatchForRecovery(limit: number, leaseMs: number, now: Date): Promise<PaymentWebhookEventRecord[]>;
  /**
   * R09 corrective pass (Codex blocker 2): `claimToken` must match the row's CURRENT token or this is
   * a silent no-op (a stale worker whose lease already expired and was reclaimed elsewhere) — never an
   * overwrite of a newer owner's outcome. See `PaymentWebhookEventRecord.claimToken`'s own doc comment.
   */
  markProcessed(id: string, claimToken: string, now: Date): Promise<void>;
  /** Records a retryable failure — `errorCode` is a fixed, sanitized diagnostic code only (see `classifyProcessingFailure`), never a raw message/stack/secret. Fenced by `claimToken` — see `markProcessed`'s own doc comment. */
  markFailedRetryable(id: string, claimToken: string, errorCode: string, nextRetryAt: Date, now: Date): Promise<void>;
  /** Records a permanent (poison) failure — no `nextRetryAt`, so it is never picked up again by recovery; remains visible via `listAll` for manual review. Fenced by `claimToken` — see `markProcessed`'s own doc comment. */
  markFailedPermanent(id: string, claimToken: string, errorCode: string, now: Date): Promise<void>;
  /** Sprint 10: reconciliation's full-scan entry point (batch, not a per-request hot path). */
  listAll(): Promise<PaymentWebhookEventRecord[]>;
  /**
   * R09 corrective pass (Codex blocker 8 — reconciliation evidence): the ONLY sanctioned way for
   * automatic reconciliation repair to look up corroborating webhook evidence for a payment —
   * `(provider, providerPaymentId, eventType)`, backed by `payment_webhook_event_trusted_lookup_idx`.
   * Bounded to at most 2 — the caller only ever needs to distinguish "zero" / "exactly one" / "more
   * than one" (ambiguous), never the full candidate set. Automatic repair code must NEVER call
   * `listAll()` to search for evidence; `listAll()` remains reserved for admin-triggered full
   * reconciliation scans.
   *
   * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 3 — EXACT PROVENANCE
   * PREDICATES): "trusted enough to repair from" means EXACTLY one of two combinations, never a
   * looser OR-composition of individual fields:
   *   (A) `source = "webhook" AND signatureVerified = true` — the original rule, unchanged.
   *   (B) `source = "provider_lookup" AND signatureVerified = false` — that source is reachable ONLY
   *       from `FailedPaymentRetryCoordinator.resolveAmbiguousRetry`'s own authenticated
   *       `PaymentProvider.retrievePaymentByIdempotencyKey` call, never from any HTTP/user-controlled
   *       route (`receiveInternalEvent`, the only method that ever writes this source, is never
   *       called from any route handler), and `signatureVerified` is always `false` for it by
   *       construction (never a webhook signature to verify). Every row of this source already
   *       carries complete, evidence-validated financial data by construction
   *       (`postLedgerEntryRequired`'s own strict check refuses to let an incomplete/mismatched one
   *       ever reach `processingStatus = "processed"` in the first place) — an authentication/
   *       evidence bar at least as strong as an inbound signature check, never weaker.
   * A row with `source = "provider_lookup" AND signatureVerified = true` does NOT qualify as
   * correctly-normalized provider-lookup evidence, and a row with `source = "webhook" AND
   * signatureVerified = false` does NOT qualify as signed-webhook evidence — even though neither
   * combination is ever actually produced by this codebase's own write paths, the read-side
   * predicate itself must never accept them. Always still requires `processingStatus = "processed"`,
   * in both cases.
   */
  findTrustedFinancialEventsForPayment(provider: string, providerPaymentId: string, eventType: string): Promise<PaymentWebhookEventRecord[]>;
  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 4 — CANONICAL SUCCESS PROVIDER
   * EVIDENCE). Finds the SINGLE trusted event whose own durable transition record
   * (`transitionAppliedAt`/`transitionToStatus`) proves it is what actually, durably applied this
   * payment's transition into `targetStatus` — the canonical evidence for a later duplicate event's
   * processor-fee comparison to fall back to BEFORE any `payment_cleared` ledger entry has posted
   * (a genuine timing gap: the transition can durably apply on one attempt while its own required
   * ledger effect fails and is retried on a LATER attempt). Deliberately NOT gated on
   * `processingStatus = "processed"` (unlike `findTrustedFinancialEventsForPayment`) — the canonical
   * event may itself still be `processing`/`failed` (retryable) at the moment a duplicate arrives; only
   * `transitionAppliedAt`/`transitionToStatus` prove it is the real, durably-applied transition. Uses
   * the SAME exact provenance predicate (signed webhook OR authenticated provider lookup) as
   * `findTrustedFinancialEventsForPayment` — never a looser one. Bounded to at most 2 rows — the
   * transition matrix structurally permits at most one event to ever durably apply a given
   * `(provider, providerPaymentId)` pair's transition into any one destination status (a second
   * attempt always finds the current status already advanced past its own allowed sources and is
   * rejected) — more than one existing row is treated as ambiguous (`null`), never guessed at, exactly
   * like `findTrustedFinancialEventsForPayment`'s own "more than one is ambiguous" convention.
   */
  findCanonicalTransitionEvidence(provider: string, providerPaymentId: string, targetStatus: PaymentAttemptStatus): Promise<PaymentWebhookEventRecord | null>;
}

/** PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Part C): a required financial field must be PRESENT with a valid non-negative integer representation — never merely "a number", and never silently defaulted when absent. Mirrors `reconciliationService.ts`'s own identical `isValidAmount`/`isValidFee` precedent. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 4 — DEDICATED PROVIDER-LOOKUP
 * EVIDENCE ERROR). Represents a `source = "provider_lookup"` event whose own carried financial
 * evidence is missing, malformed, mismatched against the authoritative internal record, excessive, or
 * otherwise financially inconsistent — see `postLedgerEntryRequired`'s own doc comment for the exact
 * checks that throw this. Deliberately a NAMED, explicitly-recognized type (not merely a generically-
 * thrown `ValidationError`, even though it extends it for the codebase's own error-hierarchy
 * consistency): `classifyProcessingFailure` checks for it BEFORE the generic `ValidationError`
 * fallback, giving it its own distinct, explicit `errorCode` rather than relying on broad
 * classification to happen to produce the right behavior. Classification: RETRYABLE / UNRESOLVED —
 * this is external-evidence-quality, not internal-financial-impossibility; NEVER `FinancialIntegrityError`
 * (reserved exclusively for a genuinely impossible AUTHORITATIVE INTERNAL financial state — a
 * provider adapter's own evidence being wrong or incomplete is exactly the kind of externally-
 * correctable condition a later retry, after the provider's own normalization is fixed, may resolve).
 * The event is never marked `processed`, no ledger entry is ever posted from it, and nothing is
 * fabricated — it remains durably retryable/visible for manual review, exactly like any other missing
 * required-effect prerequisite in this pipeline.
 */
export class ProviderLookupEvidenceError extends ValidationError {
  constructor(message: string) {
    super(message, undefined, "PROVIDER_LOOKUP_EVIDENCE_ERROR");
    this.name = "ProviderLookupEvidenceError";
  }
}

const EVENT_TYPE_TO_STATUS: Record<string, PaymentAttemptStatus> = {
  "payment.succeeded": "succeeded",
  "payment.failed": "failed",
  "payment.refunded": "refunded",
  "payment.disputed": "disputed",
  "payment.returned": "returned",
  "payment.reversed": "reversed",
};

/**
 * PAID2YOU — PACKAGE B (Stage 6 final historical-effect closure). The reverse of
 * `EVENT_TYPE_TO_STATUS`, narrowed to exactly the statuses `ALLOWED_SOURCE_STATUSES_FOR_DESTINATION`
 * lists "succeeded" as a legal source for — the only statuses a "payment.succeeded" event's own
 * required effects could ever need to check for DURABLE supersession against (see
 * `evaluateSuccessEffectDisposition`'s own doc comment). "succeeded"/"failed" are deliberately absent:
 * neither is ever a legal destination FROM "succeeded" in the existing transition matrix.
 */
const SUPERSEDING_STATUS_TO_EVENT_TYPE: Partial<Record<PaymentAttemptStatus, string>> = {
  refunded: "payment.refunded",
  disputed: "payment.disputed",
  returned: "payment.returned",
  reversed: "payment.reversed",
};

/** Sprint 10: entry type each status-changing event maps to in the ledger, when that status change should also post a reversal. `payment.succeeded` and `payout.paid` are handled separately below (different LedgerService methods). */
const EVENT_TYPE_TO_REVERSAL_ENTRY: Record<string, "refund" | "reversal" | "dispute_adjustment"> = {
  "payment.refunded": "refund",
  "payment.returned": "reversal",
  "payment.disputed": "dispute_adjustment",
  "payment.reversed": "reversal",
};

export type ReceiveWebhookResult = {
  status:
    /** This request's own synchronous attempt applied every required effect. */
    | "processed"
    /** processingStatus was already "processed" — a genuine replay; nothing was reapplied. */
    | "duplicate"
    /**
     * Durably recorded/claimed (or observed to be owned by another worker, or not yet due for
     * retry) but NOT fully processed by this request — the internal recovery scheduler
     * (`recoverBatch`) guarantees this converges independently of provider redelivery. See this
     * class's own doc comment ("HTTP acknowledgement semantics") for why this is still acknowledged
     * rather than surfaced as an HTTP failure.
     */
    | "accepted";
};

export interface FailedPaymentWorkflow {
  handlePaymentFailed(payment: PaymentAttemptRecord, failureCategory: string | null): Promise<void>;
  handlePaymentSucceeded(payment: PaymentAttemptRecord): Promise<void>;
  /**
   * PAID2YOU — PACKAGE B (Stage 6 targeted correction — exact-once supersession compensation):
   * called only for `payment.disputed`/`refunded`/`returned`/`reversed` — see
   * `PaymentWebhookService.runSupersessionCompensationRequired`'s own doc comment for exactly when.
   * `providerEventId` is THIS superseding event's own stable identity — the durable idempotency
   * correlation key a correct implementation must use (never `payment.status`/installment status
   * alone) — see `FailedPaymentRetryCoordinator.coordinateSupersession`'s own doc comment.
   */
  handlePaymentSuperseded(payment: PaymentAttemptRecord, providerEventId: string): Promise<void>;
}

/** R06: how long a claim's lease is honored before another worker may treat it as abandoned (a crashed worker must not wedge an event forever). Generous relative to this service's own expected processing time. */
export const LEASE_MS = 2 * 60 * 1000;
/**
 * R09 corrective pass (Codex blocker 5): retained only as the point after which backoff stops
 * growing and flattens (see `computeBackoffMs`) — NOT a cutoff after which a retryable event becomes
 * permanent. Codex's own finding: permanently poisoning an event after N transient failures violates
 * "eventual automatic recovery" for a condition that may later resolve (a dependency comes back, a
 * config value gets corrected). A retryable event now stays retryable forever, at this capped cadence.
 */
export const MAX_RETRYABLE_ATTEMPTS = 8;

/** R06 poison-event policy: bounded exponential backoff (30s, 60s, 120s, ... capped at 30 minutes) — a transient failure gets retried promptly; a persistent one backs off rather than hammering the same dependency at high frequency, but is never abandoned. */
export function computeBackoffMs(attemptNumber: number): number {
  const base = 30_000;
  return Math.min(base * 2 ** Math.max(0, attemptNumber - 1), 30 * 60 * 1000);
}

/**
 * R06/R09 poison-event classification — corrective pass (Codex blocker 5): NARROWED to be
 * DATA-driven, never exception-CLASS-driven. Codex's own finding: classifying every `ValidationError`
 * (e.g. "reversal before required clearing entry exists" — a missing prerequisite) or every
 * `ConfigurationError` (which may reflect a repairable deployment/configuration defect) as permanent
 * was too broad. Only `FinancialIntegrityError` (see ledgerService.ts's own doc comment — thrown ONLY
 * for demonstrably impossible financial data: negative/non-integer amounts, fee math that cannot
 * balance) is permanent/poison. Every other error — a missing dependent ledger prerequisite, a
 * transient repository/DB failure, an unresolved provider-event/payment match (blocker 3B), a
 * deployment/configuration defect — remains retryable forever at `computeBackoffMs`'s capped cadence:
 * never a dead end for a condition that may still resolve once its underlying cause is corrected.
 * `errorCode` is always a fixed, sanitized diagnostic code — never a raw error message, stack trace,
 * or any provider/secret detail.
 */
export function classifyProcessingFailure(error: unknown): { retryable: boolean; code: string } {
  if (error instanceof FinancialIntegrityError) return { retryable: false, code: "invalid_financial_data" };
  // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 4): checked BEFORE the
  // generic `ValidationError` fallback — explicit taxonomy recognition, never an incidental
  // consequence of `ProviderLookupEvidenceError` merely extending `ValidationError`.
  if (error instanceof ProviderLookupEvidenceError) return { retryable: true, code: "provider_lookup_evidence_incomplete_or_invalid" };
  if (error instanceof ValidationError) return { retryable: true, code: "unresolved_financial_prerequisite" };
  if (error instanceof ConfigurationError) return { retryable: true, code: "repairable_configuration_defect" };
  return { retryable: true, code: "transient_processing_error" };
}

/**
 * Sprint 9 webhook handling: signature verification -> durable claim (replay/redelivery-safe,
 * crash-safe — see `PaymentWebhookEventRepository`'s own doc comment) -> processing -> state
 * transition + audit -> required financial effects -> best-effort side effects.
 *
 * R06/R09 corrective pass — HTTP acknowledgement semantics (Model B, hybrid): `receiveWebhook`
 * always attempts full synchronous processing within the request, but NEVER lets a processing
 * failure propagate as an HTTP error once the event is durably claimed — every internal failure
 * after that point is caught, classified, and durably recorded (see `classifyProcessingFailure`),
 * and the request still acknowledges 2xx. This is a deliberate choice, not an oversight: the sandbox
 * `PaymentProvider` interface exposes no reliable redelivery/backoff contract to depend on, so
 * correctness must never rest on hoping the provider retries — `recoverBatch` (the scheduler-driven
 * recovery path) is the actual, provider-independent guarantee that a claimed-but-incomplete event
 * eventually converges. Only two conditions still surface as an HTTP failure, because both must
 * happen BEFORE the event is ever accepted into trusted financial processing state: (1) signature
 * verification failure (`ForbiddenError`, unchanged, non-2xx) and (2) a structurally malformed
 * request body the provider adapter cannot even parse into an event at all (`ValidationError`,
 * unchanged, non-2xx) — both fail before any webhook-event row is ever written.
 *
 * R09 required-vs-noncritical effect classification (see this class's own private methods for
 * exactly where each is invoked): payment status transition, the corresponding ledger journal entry,
 * `FailedPaymentWorkflow` (installment paid/past-due marking — schedule state material to
 * correctness, not merely a notification trigger), and agreement-lifecycle completion are all
 * REQUIRED — a failure in any of them throws, is classified, and blocks `markProcessed`, so the event
 * remains eligible for retry/recovery rather than ever being marked complete while one of them is
 * incomplete. Notifications and the fraud/risk signal remain best-effort (caught and logged) — they
 * are independently retryable/observable through their own architecture (NotificationService's own
 * delivery/dedup guarantees; RiskEventService is advisory) and their absence never corrupts financial
 * state.
 */
export class PaymentWebhookService {
  private readonly platformFeePolicy: PlatformFeePolicy;

  constructor(
    private readonly deps: {
      provider: PaymentProvider;
      events: PaymentWebhookEventRepository;
      payments: PaymentAttemptRepository;
      /**
       * PACKAGE B — remaining Codex blockers (durable provider-event transition progress): the
       * SOLE way `applyEvent` ever attempts a status transition — see
       * `PaymentTransitionCoordinator`'s own doc comment for exactly why a plain
       * `payments.updateStatusIfLegalTransition` call is no longer sufficient on its own. Required
       * (not optional) — this is the central mechanism, not a best-effort enhancement.
       */
      transitionCoordinator: PaymentTransitionCoordinator;
      ledger: LedgerService;
      audit: AuditService;
      /** Sprint 13: installment past_due/paid marking, notification, and retry scheduling — optional, see FailedPaymentWorkflow's doc comment. R09: now REQUIRED-effect-classified when wired (see this class's own doc comment) — still optional here so pre-Sprint-13 tests are unaffected. */
      failedPaymentWorkflow?: FailedPaymentWorkflow;
      /**
       * Sprint 17 (docs/sprints/SPRINT_17_Notifications.md) Product Owner review pass addition —
       * notifies both parties on a "succeeded" (`payment_cleared`) or "disputed" (`payment_disputed`)
       * transition. Optional; a notification failure here is caught and logged, never thrown
       * (noncritical — see this class's own doc comment).
       */
      notifications?: NotificationService;
      profileOwners?: ProfileOwnerReader;
      /**
       * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md):
       * recomputes and applies the agreement's status once a provider-cleared payment may have just
       * completed it. Optional; R09: REQUIRED-effect-classified when wired (see this class's own doc
       * comment).
       */
      completion?: AgreementCompletionChecker;
      /**
       * SPRINT_19_FraudRisk_SecurityHardening §12: records a "repeated payment failure" signal.
       * Optional; noncritical (see this class's own doc comment) — never fails the webhook.
       */
      riskEvents?: RiskEventService;
      /**
       * PAID2YOU — PACKAGE B (R06+R09 definitive implementation, Part XXII): see
       * `ConflictExceptionRecorder`'s own doc comment. Optional so every pre-existing test context
       * that never exercises this is unaffected; every real production wiring supplies it.
       */
      conflictExceptions?: ConflictExceptionRecorder;
      /**
       * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 2 — CENTRALIZE
       * PAID2YOU PLATFORM-FEE AUTHORITY): the SINGLE source of `platformFeeMinorUnits` for a
       * provider-routed payment's ledger posting — see `PlatformFeePolicy`'s own doc comment.
       * Defaults to `DefaultPlatformFeePolicy` (today's actual authoritative rule: explicit zero) so
       * every pre-existing test context that never wires this is unaffected — the default IS the
       * real production behavior, not a test-only stand-in.
       */
      platformFeePolicy?: PlatformFeePolicy;
    },
  ) {
    this.platformFeePolicy = deps.platformFeePolicy ?? new DefaultPlatformFeePolicy();
  }

  async receiveWebhook(input: { rawBody: string; signatureHeader: string }): Promise<ReceiveWebhookResult> {
    const signatureValid = this.deps.provider.verifyWebhookSignature(input.rawBody, input.signatureHeader);
    if (!signatureValid) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }
    // Throws ValidationError for a structurally malformed body — before any webhook-event row is
    // ever written, matching this class's own doc comment on what may still surface as non-2xx.
    const parsed = this.deps.provider.parseWebhookEvent(input.rawBody);
    // Genuinely arrived as an inbound webhook delivery, and the signature above was genuinely
    // verified — both true statements, recorded truthfully (see `PaymentWebhookEventRecord.source`'s
    // own doc comment).
    return this.claimAndProcess(parsed.provider, parsed.providerEventId, parsed.eventType, parsed.data, "webhook", true);
  }

  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B2 — Parts A/C): the sanctioned way
   * an INTERNAL, already-authoritative outcome discovery (e.g.
   * `FailedPaymentRetryCoordinator.resolveAmbiguousRetry`'s own
   * `provider.retrievePaymentByIdempotencyKey` lookup) may apply a definitive provider outcome — by
   * routing it through the EXACT SAME durable claim + required-effect pipeline (transition validation,
   * audit, ledger, installment workflow, agreement lifecycle) a real webhook delivery uses, never a
   * direct status write. `providerEventId` must be a synthetic identity distinct from any real
   * provider event id (e.g. `ambiguity-resolution:${idempotencyKey}`) — durably deduplicated exactly
   * like any other event via `(provider, providerEventId)`'s own uniqueness. A LATER real webhook for
   * the SAME payment (its own, genuinely distinct providerEventId) is safely rejected as a dead no-op
   * by the existing legal-transition matrix once this synthetic event has already applied the
   * transition — never a duplicated effect (see `applyEvent`'s own doc comment on
   * `isTransitionPermanentlyIllegal`). Skips signature verification/raw-body parsing entirely — the
   * caller is itself the trusted source (a real, already-authenticated provider SDK call), not an
   * untrusted inbound HTTP request. This method is NEVER reachable from any HTTP route handler or
   * other user-controlled entry point — its only caller anywhere in this codebase is
   * `FailedPaymentRetryCoordinator.resolveAmbiguousRetry`.
   *
   * `input.data` is durably persisted with `source = "provider_lookup"` and `signatureVerified =
   * false` — NEVER `true`: no webhook signature was ever checked for this row, and pretending
   * otherwise would be false provenance (Codex's own Section B2 finding). Trust for THIS source
   * instead rests on `postLedgerEntryRequired`'s own strict evidence-completeness check (see that
   * method's own doc comment) — never on this field.
   */
  async receiveInternalEvent(input: { provider: string; providerEventId: string; eventType: string; data: Record<string, unknown> }): Promise<ReceiveWebhookResult> {
    return this.claimAndProcess(input.provider, input.providerEventId, input.eventType, input.data, "provider_lookup", false);
  }

  private async claimAndProcess(
    provider: string,
    providerEventId: string,
    eventType: string,
    payload: Record<string, unknown>,
    source: PaymentWebhookEventSource,
    signatureVerified: boolean,
  ): Promise<ReceiveWebhookResult> {
    const now = new Date();
    const inserted = await this.deps.events.tryInsertAndClaim({
      provider,
      providerEventId,
      eventType,
      source,
      signatureVerified,
      payload,
      leaseMs: LEASE_MS,
      now,
    });

    let claimed: PaymentWebhookEventRecord;
    if (inserted) {
      claimed = inserted;
    } else {
      const claim = await this.deps.events.claimExistingForProcessing(provider, providerEventId, LEASE_MS, now);
      if (claim.outcome === "duplicate") return { status: "duplicate" };
      if (claim.outcome === "in_progress" || claim.outcome === "not_due") return { status: "accepted" };
      claimed = claim.record;
    }

    return this.processAndFinalize(claimed);
  }

  /**
   * R06 recovery scheduler entry point (see the scheduler route for the actual cron wiring). Claims
   * and processes a bounded batch — never an unbounded full-table scan — and is safe to run from any
   * number of simultaneous scheduler invocations (the claim itself is `FOR UPDATE SKIP LOCKED`).
   */
  async recoverBatch(limit: number, now: Date = new Date()): Promise<{ claimed: number; processed: number; failed: number }> {
    const claimedEvents = await this.deps.events.claimBatchForRecovery(limit, LEASE_MS, now);
    let processed = 0;
    let failed = 0;
    for (const event of claimedEvents) {
      const result = await this.processAndFinalize(event);
      if (result.status === "processed") processed += 1;
      else failed += 1;
    }
    return { claimed: claimedEvents.length, processed, failed };
  }

  private async processAndFinalize(claimed: PaymentWebhookEventRecord): Promise<ReceiveWebhookResult> {
    // R09 corrective pass (Codex blocker 2): every finalization is fenced by the exact token this
    // claim was handed — see `PaymentWebhookEventRecord.claimToken`'s own doc comment. A row claimed
    // before this migration backfilled a token (practically unreachable — every claim path always
    // mints a fresh one) is left untouched rather than finalized without fencing.
    const claimToken = claimed.claimToken;
    if (!claimToken) {
      logger.error("payment_webhook_missing_claim_token", { eventId: claimed.id, eventType: claimed.eventType });
      return { status: "accepted" };
    }
    try {
      await this.applyEvent(claimed, claimToken);
      await this.deps.events.markProcessed(claimed.id, claimToken, new Date());
      return { status: "processed" };
    } catch (error) {
      const { retryable, code } = classifyProcessingFailure(error);
      logger.error("payment_webhook_processing_failed", {
        eventId: claimed.id,
        eventType: claimed.eventType,
        attempt: claimed.processingAttempts,
        retryable,
        code,
      });
      if (retryable) {
        const nextRetryAt = new Date(Date.now() + computeBackoffMs(claimed.processingAttempts));
        await this.deps.events.markFailedRetryable(claimed.id, claimToken, code, nextRetryAt, new Date());
      } else {
        await this.deps.events.markFailedPermanent(claimed.id, claimToken, code, new Date());
      }
      return { status: "accepted" };
    }
  }

  /**
   * PACKAGE B — remaining Codex blockers (durable provider-event transition progress).
   * `claimed.providerEventId` threads the durable identity of the CALLER's own webhook-event row
   * into the audit-idempotency key (blocker 9) — never used for payment lookup, which remains keyed
   * on `providerPaymentId` inside the payload. `claimed.transitionAppliedAt`/`transitionFromStatus`
   * are this event's OWN durable transition record — see `PaymentTransitionCoordinator`'s own doc
   * comment for why current payment status alone can never answer "did MY transition ever apply."
   */
  private async applyEvent(claimed: PaymentWebhookEventRecord, claimToken: string): Promise<void> {
    const eventType = claimed.eventType;
    const data = claimed.payload as Record<string, unknown>;
    const providerEventId = claimed.providerEventId;

    const isRecognizedEventType = eventType === "payout.paid" || eventType in EVENT_TYPE_TO_STATUS;
    if (!isRecognizedEventType) return; // genuinely unsupported/unrecognized event type — safe no-op.

    const providerPaymentId = typeof data.providerPaymentId === "string" ? data.providerPaymentId : null;
    if (!providerPaymentId) {
      // R09 corrective pass (Codex blocker 3B): a RECOGNIZED financial event missing its own payment
      // identity must never silently become "processed" — a provider callback can legitimately arrive
      // before our own providerPaymentId persistence completes, and this must remain recoverable
      // (classifyProcessingFailure treats a plain ValidationError as retryable, not permanent).
      throw new ValidationError("payment_webhook_missing_provider_payment_id");
    }
    const payment = await this.deps.payments.findByProviderPaymentId(providerPaymentId);
    if (!payment) {
      // Same rationale as above — recognized event, no matching payment found (yet); retryable, never
      // a silent no-op that lets a real required effect go permanently unapplied.
      throw new ValidationError("payment_webhook_no_matching_payment");
    }
    // PAID2YOU — PACKAGE B (Stage 6 final architecture closure, Item 1 — PROVIDER NAMESPACE MISMATCH
    // IS A DURABLE IDENTITY CONFLICT): a genuinely mismatched `providerName` for a `providerPaymentId`
    // that already resolves to an existing Paid2You payment is NOT a transient lookup failure —
    // retrying the identical event will never make the claimed provider become the payment's actual
    // one. This is conflicting payment-identity evidence, handled exactly like every other material
    // conflict this service detects: no state mutation, a durable reconciliation exception via the
    // same atomic `ensureOpenException` mechanism, and the event finalized (never left spinning in an
    // infinite retry loop solely because provider namespaces disagree). See
    // `recordProviderIdentityMismatch`'s own doc comment for the exact behavior and its fallback when
    // no exception recorder is wired.
    if (payment.providerName !== claimed.provider) {
      await this.recordProviderIdentityMismatch(payment, claimed.provider, providerEventId);
      return;
    }

    if (eventType === "payout.paid") {
      await this.applyPayoutRequired(payment, providerEventId);
      return;
    }

    // `isRecognizedEventType` above already proved `eventType` is a key of `EVENT_TYPE_TO_STATUS`
    // (the `eventType === "payout.paid"` branch already returned) — asserted non-null here once
    // rather than re-narrowing at every use below.
    const newStatus = EVENT_TYPE_TO_STATUS[eventType]!;
    const failureCategory =
      newStatus === "failed" && typeof data.failureCategory === "string" ? data.failureCategory : undefined;

    // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 4 — MATERIAL EVIDENCE MUST BE
    // VALIDATED ON FIRST LEGAL EVENT, NOT ONLY DEAD NO-OPS): runs BEFORE any transition attempt — the
    // FIRST legal application of a "payment.succeeded" transition previously had NO conflict-detection
    // gate at all (only a dead-end duplicate ever reached `detectAndRecordConflict`), letting a first
    // event carrying materially wrong amount/currency evidence transition/process using the INTERNAL
    // payment's own values while silently ignoring the conflicting provider evidence. See
    // `validateFirstEventMaterialEvidence`'s own doc comment.
    if (eventType === "payment.succeeded" && (await this.validateFirstEventMaterialEvidence(payment, data, providerEventId))) {
      return; // durably surfaced as a reconciliation exception — no transition, no ledger, no workflow/lifecycle.
    }

    let current = payment;
    let fromStatus: PaymentAttemptStatus | null = claimed.transitionFromStatus;

    if (!claimed.transitionAppliedAt) {
      // CASE B (never applied): this exact event has never durably recorded a successful transition
      // — attempt it now, atomically (lock, validate, update payment + persist this event's own
      // transition record, all in one transaction — see PaymentTransitionCoordinator).
      const result = await this.deps.transitionCoordinator.applyTransition({
        paymentAttemptId: current.id,
        webhookEventId: claimed.id,
        claimToken,
        newStatus,
        fields: failureCategory !== undefined ? { failureReason: failureCategory } : {},
        allowedSourceStatuses: ALLOWED_SOURCE_STATUSES_FOR_DESTINATION[newStatus] ?? [],
      });

      if (result.outcome === "rejected") {
        current = result.payment;
        logger.warn("payment_webhook_stale_event_ignored", {
          paymentAttemptId: current.id,
          eventType,
          currentStatus: current.status,
          attemptedStatus: newStatus,
        });
        if (isTransitionPermanentlyIllegal(current.status, newStatus)) {
          // The current status can never legally reach one of this destination's allowed sources
          // via any future event either (e.g. a stale `succeeded -> failed`) — a genuinely dead,
          // safe no-op. No effect of any kind was applied; the event may be marked processed.
          //
          // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1): before treating
          // this as a harmless no-op, compare its OWN carried COMPLETE financial identity against the
          // authoritative payment record and existing trusted evidence — a materially conflicting
          // amount/currency/fee/outcome must become automatically visible, never silently discarded
          // merely because the transition itself is a dead end.
          await this.detectAndRecordConflict(current, data, providerEventId, eventType, newStatus);
          return;
        }
        // PROVISIONAL: current status could still legally advance into an allowed source for this
        // destination later (e.g. `pending -> refunded` before any `succeeded` event has arrived
        // yet) — this transition was NEVER applied and must remain retryable/unresolved, never a
        // silent no-op that would let a legitimate future retry's required effects go unapplied.
        throw new ValidationError("payment_webhook_transition_prerequisite_not_yet_met");
      }

      current = result.payment;
      fromStatus = result.fromStatus;
      await this.recordTransitionAudit(current, providerEventId, eventType, fromStatus, newStatus);
    } else {
      // CASE A (previously applied): this exact event's transition already durably committed on an
      // earlier attempt — never re-validate/re-attempt it against whatever the CURRENT status
      // happens to be now (it may have legitimately moved on further, e.g. to "disputed"). Re-read
      // the authoritative row so the required ledger effect below sees real current state, and
      // (re)ensure the required transition audit exists — idempotent, reconstructed from this
      // event's OWN durable from/to record, never inferred from current status.
      const latest = await this.deps.payments.findById(current.id);
      if (latest) current = latest;
      if (fromStatus) {
        await this.recordTransitionAudit(current, providerEventId, eventType, fromStatus, newStatus);
      }
    }

    // The ledger consequence of THIS event is a historical fact tied to its own (now durably
    // known-applied) transition — independent of whatever the CURRENT payment status has since
    // become — so it is always attempted once we reach this line, never gated on whether newStatus
    // still matches current status. `LedgerService`'s own idempotent get-or-post methods make this
    // safe to retry unconditionally; a genuinely missing prerequisite (e.g. reversing before the
    // clearing entry exists) throws a retryable `ValidationError` (see `classifyProcessingFailure`),
    // not a silent skip.
    await this.postLedgerEntryRequired(eventType, current, data, claimed.source);

    // PAID2YOU — PACKAGE B (Stage 6 final historical-effect closure). `runFailedPaymentWorkflowRequired`
    // (installment success/failure semantics, retry cancellation) and `checkCompletionRequired`
    // (agreement lifecycle) are REQUIRED effects of THIS event's own historical transition — like the
    // ledger posting immediately above, they must be evaluated on every attempt (including a retry
    // completing work a prior attempt left unfinished), NEVER skipped merely because the payment's
    // CURRENT status has since moved on. But for a "payment.succeeded" event specifically, "moved on"
    // must NEVER be answered from `current.status` alone (that would blindly REPLAY the now-obsolete
    // success mutation the instant status changes, before the later event's OWN required effects are
    // even known to be complete) — see `evaluateSuccessEffectDisposition`'s own doc comment for the
    // exact three-way disposition (`apply` / `superseded_safely` / `wait_for_superseding_event`) and
    // the DURABLE proof it requires. Every OTHER event type's own workflow/lifecycle call remains
    // unconditional exactly as before: "failed" is truly terminal (current.status can never diverge
    // from it once applied), and every OTHER status's own callee branches (`status === "failed"` /
    // `status === "succeeded"` in `runFailedPaymentWorkflowRequired`, `status !== "succeeded"` in
    // `checkCompletionRequired`) are already structurally no-ops for it — only "succeeded" has a
    // reachable, later-superseding future.
    if (eventType === "payment.succeeded") {
      const disposition = await this.evaluateSuccessEffectDisposition(current);
      if (disposition === "wait_for_superseding_event") {
        // The later event that (per current.status) appears to supersede this success has not yet
        // durably proven itself complete (`transitionAppliedAt` unset, or `processingStatus` not yet
        // "processed") — or no such durable proof exists at all (current.status changed by some other
        // means never durably recorded as a legal progression from "succeeded"). Blindly running
        // `coordinateSuccess`/`checkAndAdvance` here would either replay an obsolete mutation UNDER a
        // still-unreconciled later state, or fabricate supersession from status alone — both refused.
        // This event's OWN ledger/audit work (already completed above/via recordTransitionAudit) is
        // preserved; only its own workflow/lifecycle disposition remains retryable/unresolved.
        throw new ValidationError("payment_webhook_historical_effect_awaiting_superseding_event");
      }
      if (disposition === "apply") {
        await this.runFailedPaymentWorkflowRequired(newStatus, current, failureCategory ?? null);
        await this.checkCompletionRequired(newStatus, current);
      }
      // "superseded_safely": DO NOT call either — a later, fully-processed, durably-proven event has
      // already superseded this success; no mutation of any kind is required or safe here.
    } else {
      await this.runFailedPaymentWorkflowRequired(newStatus, current, failureCategory ?? null);
      await this.checkCompletionRequired(newStatus, current);
      // PAID2YOU — PACKAGE B (Stage 6 blocking substage — post-success supersession compensation,
      // ARCHITECT DECISION): THIS event (refunded/disputed/returned/reversed) is the one whose OWN
      // transition just proved it superseded an earlier success — not the stale success event's own
      // retry (which may never happen again at all: the ordinary case is that the original success
      // event already fully processed once, cleanly, days or weeks before this arrives, and will
      // never be revisited). Both calls are REQUIRED effects of THIS event's own historical transition
      // — self-gated inside each callee to only ever act for these four statuses, and each is
      // exact-once by construction (see `runSupersessionCompensationRequired`/
      // `checkSupersessionCompletionRequired`'s own doc comments) — never a parallel state machine,
      // reusing the exact same required-effect/idempotency architecture as every other effect above.
      await this.runSupersessionCompensationRequired(newStatus, current, providerEventId);
      await this.checkSupersessionCompletionRequired(newStatus, current, providerEventId);
    }

    const statusIsCurrent = current.status === newStatus;
    if (statusIsCurrent) {
      await this.notifyPaymentStatus(newStatus, current);
      await this.recordFailureRiskSignal(newStatus, current);
    }
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 6 final historical-effect closure). Decides whether a
   * "payment.succeeded" event's required installment-workflow/agreement-lifecycle consequences may be
   * (re)applied, are already safely superseded, or must wait — NEVER inferred from `current.status`
   * alone. Three outcomes:
   *   - `"apply"`: the payment's CURRENT authoritative status is STILL "succeeded" — run normal
   *     success recovery (`coordinateSuccess`, `checkAndAdvance`); idempotent/exact-once by
   *     construction in both.
   *   - `"superseded_safely"`: the current status is one of the supported later superseding outcomes
   *     (disputed/returned/reversed/refunded, per the existing `ALLOWED_SOURCE_STATUSES_FOR_DESTINATION`
   *     matrix) AND there exists a DURABLE, trusted event proving it — `transitionAppliedAt` set,
   *     `transitionFromStatus = "succeeded"`, `transitionToStatus` equal to the current status, for
   *     the SAME provider/payment identity (`findTrustedFinancialEventsForPayment`'s own exact
   *     provenance predicate — never a looser query), AND that event's own `processingStatus =
   *     "processed"`. The `processed` requirement is load-bearing: a later transition that merely
   *     changed `payment.status` but whose OWN required ledger/workflow/lifecycle consequences are
   *     still incomplete is not proof the historical success effect is safely obsolete — it is only
   *     proof a DIFFERENT required effect is *also* still outstanding.
   *   - `"wait_for_superseding_event"`: current status differs from "succeeded" but the durable proof
   *     above does not (yet) exist — either the superseding event hasn't finished processing, or
   *     current.status changed by some means with no durable superseding record at all. Never treated
   *     as either "apply" (would replay/duplicate an obsolete mutation) or "superseded_safely" (would
   *     fabricate supersession from status alone) — the caller must leave this event's own
   *     workflow/lifecycle disposition retryable/unresolved.
   */
  private async evaluateSuccessEffectDisposition(current: PaymentAttemptRecord): Promise<"apply" | "superseded_safely" | "wait_for_superseding_event"> {
    if (current.status === "succeeded") return "apply";
    const supersedingEventType = SUPERSEDING_STATUS_TO_EVENT_TYPE[current.status];
    if (!supersedingEventType || !current.providerPaymentId) return "wait_for_superseding_event";
    const trustedEvents = await this.deps.events.findTrustedFinancialEventsForPayment(current.providerName, current.providerPaymentId, supersedingEventType);
    const durablySuperseded = trustedEvents.some(
      (event) => event.transitionAppliedAt !== null && event.transitionFromStatus === "succeeded" && event.transitionToStatus === current.status,
    );
    return durablySuperseded ? "superseded_safely" : "wait_for_superseding_event";
  }

  /**
   * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1 — COMPLETE TRUSTED-
   * EVIDENCE CONFLICT DETECTION; Stage 6 architecture closure — outcome compatibility and
   * event-specific fee comparison). Only fields the event ACTUALLY carries are compared — absence is
   * never a conflict (mirrors `ReconciliationService.reconcilePaymentAttempt`'s own existing amount/
   * currency-mismatch detection, which this complements rather than duplicates: that method scans the
   * WHOLE table on an admin-triggered/scheduled pass; this one runs INLINE, automatically, on every
   * trusted event this service itself processes, so a conflict is visible the moment it is detected,
   * never only after a separate scan happens to run). Compares the COMPLETE material financial
   * identity, each against its own correct authority:
   *   - `amountMinorUnits`/`currency`: against the authoritative internal payment record.
   *   - `processorFeeMinorUnits`/`platformFeeMinorUnits`: ONLY for `eventType === "payment.succeeded"`,
   *     each against its OWN correct authority — `processorFeeMinorUnits` (provider-authoritative)
   *     against the already-posted `processor_fee_expense` ledger effect; `platformFeeMinorUnits`
   *     (Paid2You-OWNED, never the event's/provider's to supply, even on a genuinely signed webhook)
   *     between Paid2You's OWN two internal sources — the live policy result and the already-posted
   *     `platform_fee_revenue` ledger effect — NEVER the incoming event's own field. See the
   *     event-specific-fee-comparison note right before the fee-check block for the full rationale.
   *   - outcome compatibility: NEVER a bare "does the attempted destination status differ from the
   *     CURRENT status" check (that would flag every legitimate historical duplicate arriving after
   *     the payment has since legally progressed further — e.g. a late-arriving, genuinely-duplicate
   *     `payment.succeeded` event for a payment that has since become `disputed`/`refunded`/etc. — as
   *     a false conflict). See `isHistoricallyCompatibleOutcome`'s own doc comment for the real
   *     algorithm: durable transition history PROVES the attempted outcome actually occurred, and the
   *     current status is a legal further progression from it, per the existing transition matrix
   *     (`ALLOWED_SOURCE_STATUSES_FOR_DESTINATION`) — never a second, independently-derived state
   *     machine. Only reached at all when `attemptedStatus !== payment.status`; the equal case is
   *     trivially compatible (the existing same-outcome duplicate path).
   * A genuine, material difference is recorded as an OPEN reconciliation exception via
   * `ensureOpenException` — a real DB-enforced atomic upsert, never a "find open then insert" race
   * (see `ConflictExceptionRecorder`'s own doc comment) — so two genuinely concurrent detections of
   * the SAME conflicting event can never create two open exceptions. Optional dependency: a safe
   * no-op when `conflictExceptions` is not wired.
   */

  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 4 — MATERIAL EVIDENCE MUST BE
   * VALIDATED ON FIRST LEGAL EVENT, NOT ONLY DEAD NO-OPS). Called BEFORE any transition attempt, for
   * EVERY "payment.succeeded" event — first legal application, already-applied replay, and dead-end
   * duplicate alike — never merely the dead-no-op path `detectAndRecordConflict` covers. Validates
   * provider-authoritative `amountMinorUnits`/`currency` against Paid2You's own authoritative payment
   * identity; only fields the event ACTUALLY carries are compared (absence is never a conflict,
   * matching every other check in this class). Returns `true` (block the transition/ledger/
   * workflow/lifecycle entirely) on ANY mismatch, regardless of whether `conflictExceptions` is wired
   * — the safety property (never transition on wrong evidence) does not depend on having somewhere to
   * durably record it; the recording itself is a best-effort, idempotent side effect when it is wired.
   * A genuine first-event conflict is never a retryable outage — once detected, the caller returns
   * without throwing, so the event finalizes as `processed` (durably surfaced, never re-attempted).
   */
  private async validateFirstEventMaterialEvidence(payment: PaymentAttemptRecord, data: Record<string, unknown>, providerEventId: string): Promise<boolean> {
    const checks: { type: ConflictExceptionType; conflict: boolean; expected: unknown; actual: unknown }[] = [
      {
        type: "amount_mismatch",
        conflict: typeof data.amountMinorUnits === "number" && data.amountMinorUnits !== payment.amountMinorUnits,
        expected: payment.amountMinorUnits,
        actual: data.amountMinorUnits,
      },
      {
        type: "currency_mismatch",
        conflict: typeof data.currency === "string" && data.currency !== payment.currency,
        expected: payment.currency,
        actual: data.currency,
      },
    ];
    const conflicting = checks.filter((check) => check.conflict);
    if (conflicting.length === 0) return false;
    if (this.deps.conflictExceptions) {
      for (const { type, expected, actual } of conflicting) {
        await this.deps.conflictExceptions.ensureOpenException({ exceptionType: type, paymentAttemptId: payment.id, providerEventId, details: { expected, actual } });
      }
    }
    return true;
  }

  private async detectAndRecordConflict(
    payment: PaymentAttemptRecord,
    data: Record<string, unknown>,
    providerEventId: string,
    eventType: string,
    attemptedStatus: PaymentAttemptStatus,
  ): Promise<void> {
    if (!this.deps.conflictExceptions) return;
    const checks: { type: ConflictExceptionType; conflict: boolean; expected: unknown; actual: unknown }[] = [
      {
        type: "amount_mismatch",
        conflict: typeof data.amountMinorUnits === "number" && data.amountMinorUnits !== payment.amountMinorUnits,
        expected: payment.amountMinorUnits,
        actual: data.amountMinorUnits,
      },
      {
        type: "currency_mismatch",
        conflict: typeof data.currency === "string" && data.currency !== payment.currency,
        expected: payment.currency,
        actual: data.currency,
      },
    ];

    if (attemptedStatus !== payment.status) {
      const historicallyCompatible = await this.isHistoricallyCompatibleOutcome(payment, eventType, attemptedStatus);
      checks.push({
        type: "status_mismatch",
        conflict: !historicallyCompatible,
        expected: payment.status,
        actual: attemptedStatus,
      });
    }

    // PAID2YOU — PACKAGE B (Stage 6 architecture closure, Item 1 — EVENT-SPECIFIC FEE COMPARISON;
    // Stage 6 final architecture closure, Item 2 — PLATFORM FEE MUST REMAIN PAID2YOU-OWNED EVIDENCE):
    // this ledger model tracks processor/platform fee evidence ONLY for the "payment.succeeded"
    // outcome (the `payment_cleared` entry's own postings) — a reversal-type entry
    // (`LedgerService.reversePayment`'s own `refund`/`reversal`/`dispute_adjustment` postings) never
    // carries `processor_fee_expense`/`platform_fee_revenue` legs of its own, so there is no
    // applicable financial effect to compare a refund/dispute/return/reversal event's fee fields
    // against — neither fee check ever runs for any event type other than "payment.succeeded".
    //
    // The two fee checks use DELIBERATELY DIFFERENT authority models, per this codebase's own fee
    // ownership split:
    //   - PROCESSOR FEE is PROVIDER-authoritative evidence: the incoming event's own carried
    //     `processorFeeMinorUnits` (when present) is compared against the already-posted
    //     `processor_fee_expense` ledger effect — the provider's own fee, once posted, IS the
    //     authoritative record of what that provider actually charged.
    //   - PLATFORM FEE is Paid2You-OWNED evidence, never the provider's/event's to supply. An inbound
    //     event's own `platformFeeMinorUnits` field — even on a genuinely signed, authenticated
    //     webhook — is NEVER treated as authoritative Paid2You fee evidence and is NEVER read here.
    //     (A `provider_lookup` event's own persisted `platformFeeMinorUnits` was itself already
    //     internally derived from this SAME policy by `resolveAmbiguousRetry` at resolution time —
    //     Paid2You-normalized evidence, not provider-supplied — so excluding it from this comparison
    //     loses nothing.) Instead this compares Paid2You's OWN two internal sources of truth against
    //     each other: the policy's CURRENT authoritative result vs. the platform fee Paid2You ITSELF
    //     already posted (`platform_fee_revenue`) when this payment originally settled. These can only
    //     ever disagree if the POLICY's own live result changes between original settlement and a
    //     later re-examination — a genuine internal (Paid2You-vs-Paid2You) drift, never something an
    //     external party's payload could ever trigger.
    if (eventType === "payment.succeeded") {
      const postedEntry = await this.deps.ledger.findEntry(payment.id, "payment_cleared");
      if (typeof data.processorFeeMinorUnits === "number") {
        // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 4 — CANONICAL SUCCESS PROVIDER
        // EVIDENCE): a genuine timing gap exists when the success transition already durably applied
        // but its OWN required `payment_cleared` posting has not (yet) completed — a later duplicate
        // carrying a DIFFERENT processor fee must still be compared against something, never silently
        // waved through merely because there is no clearing entry yet. Falls back to the canonical
        // event that durably applied this exact transition (see `findCanonicalTransitionEvidence`'s
        // own doc comment) — never required to already be `processed`.
        const postedProcessorFee = postedEntry
          ? postedEntry.postings.filter((p) => p.accountType === "processor_fee_expense").reduce((sum, p) => sum + p.amountMinorUnits, 0)
          : await (async () => {
              const canonical = await this.deps.events.findCanonicalTransitionEvidence(payment.providerName, payment.providerPaymentId ?? "", "succeeded");
              const canonicalFee = canonical ? (canonical.payload as Record<string, unknown>).processorFeeMinorUnits : undefined;
              return typeof canonicalFee === "number" ? canonicalFee : null;
            })();
        if (postedProcessorFee !== null) {
          checks.push({
            type: "processor_fee_mismatch",
            conflict: data.processorFeeMinorUnits !== postedProcessorFee,
            expected: postedProcessorFee,
            actual: data.processorFeeMinorUnits,
          });
        }
      }

      // PLATFORM FEE: an internal Paid2You-vs-Paid2You comparison only — before `payment_cleared`
      // exists there is no external platform-fee conflict to detect (the provider is never the
      // authority for this field, so there is nothing of its own to fall back to); skip entirely.
      if (postedEntry) {
        const authoritativePlatformFee = await this.platformFeePolicy.getPlatformFeeMinorUnits({
          amountMinorUnits: payment.amountMinorUnits,
          currency: payment.currency,
          paymentMethod: payment.paymentMethod,
          agreementId: payment.agreementId,
        });
        const postedPlatformFee = postedEntry.postings
          .filter((p) => p.accountType === "platform_fee_revenue")
          .reduce((sum, p) => sum + p.amountMinorUnits, 0);
        checks.push({
          type: "platform_fee_mismatch",
          conflict: authoritativePlatformFee !== postedPlatformFee,
          expected: authoritativePlatformFee,
          actual: postedPlatformFee,
        });
      }
    }

    for (const { type, conflict, expected, actual } of checks) {
      if (!conflict) continue;
      await this.deps.conflictExceptions.ensureOpenException({
        exceptionType: type,
        paymentAttemptId: payment.id,
        providerEventId,
        details: { expected, actual },
      });
    }
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 6 architecture closure, Item 1 — EVENT/OUTCOME COMPATIBILITY
   * SEMANTICS): answers "is this incoming event's attempted outcome a historically compatible
   * duplicate," never "does it merely differ from the current status." Compatible when BOTH:
   *   (a) durable history PROVES `attemptedStatus` was actually, legitimately reached at some point —
   *       a previously-processed TRUSTED event of this SAME `eventType` (never a different one:
   *       `EVENT_TYPE_TO_STATUS` is a strict 1:1 mapping, so no other event type could have produced
   *       this exact outcome) durably recorded a REAL applied transition into it
   *       (`transitionAppliedAt` set, `transitionToStatus === attemptedStatus`) — reuses
   *       `findTrustedFinancialEventsForPayment`'s own exact provenance predicate (Item 3/4), never a
   *       looser query; and
   *   (b) the payment's CURRENT status is a legal further progression from that outcome per the
   *       EXISTING transition matrix (`ALLOWED_SOURCE_STATUSES_FOR_DESTINATION`) — reused, never
   *       duplicated into a second, independently-derived state machine.
   * Current status is used here only as ONE input (part of check (b)) — never the sole comparison.
   * Never replaces `isTransitionPermanentlyIllegal`'s own dead-end determination (still decides
   * whether this event's transition attempt was itself provisional vs. permanently illegal, upstream
   * of this call); this only answers whether that already-dead-end mismatch is a genuine conflict.
   */
  private async isHistoricallyCompatibleOutcome(payment: PaymentAttemptRecord, eventType: string, attemptedStatus: PaymentAttemptStatus): Promise<boolean> {
    if (!payment.providerPaymentId) return false;
    const legalProgression = (ALLOWED_SOURCE_STATUSES_FOR_DESTINATION[payment.status] ?? []).includes(attemptedStatus);
    if (!legalProgression) return false;
    const trustedEvents = await this.deps.events.findTrustedFinancialEventsForPayment(payment.providerName, payment.providerPaymentId, eventType);
    return trustedEvents.some((event) => event.transitionAppliedAt !== null && event.transitionToStatus === attemptedStatus);
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 6 final architecture closure, Item 1 — PROVIDER NAMESPACE MISMATCH IS
   * A DURABLE IDENTITY CONFLICT). `providerPaymentId` identity is structurally guaranteed by the
   * caller's own lookup (`findByProviderPaymentId` — a DB-enforced-unique, exact-match query; see that
   * call site's own doc comment) — never re-checked here. `provider` identity is not: the event's own
   * claimed provider genuinely disagreeing with the resolved payment's authoritative `providerName` is
   * conflicting evidence a retry can never resolve on its own, so it is recorded exactly like every
   * other material conflict this service detects — via the SAME atomic `ensureOpenException` mechanism
   * (idempotent per `(paymentAttemptId, providerEventId, exceptionType)`, so redelivery of the exact
   * same event — already independently deduplicated by the outer webhook-event claim/dedupe layer —
   * or genuinely concurrent processing of it can never create a second open exception), then the
   * caller returns normally: no status mutation, no ledger posting, no installment/lifecycle effect —
   * and the event is finalized (`markProcessed`) rather than left retrying forever over a disagreement
   * retrying can never fix. Falls back to the prior throwing behavior only when no exception recorder
   * is wired (an optional dependency; every production call site wires one) — never silently drops the
   * conflict in that case.
   */
  private async recordProviderIdentityMismatch(payment: PaymentAttemptRecord, incomingProvider: string, providerEventId: string): Promise<void> {
    if (!this.deps.conflictExceptions) {
      throw new ValidationError("payment_webhook_provider_namespace_mismatch");
    }
    await this.deps.conflictExceptions.ensureOpenException({
      exceptionType: "provider_identity_mismatch",
      paymentAttemptId: payment.id,
      providerEventId,
      details: { expectedProvider: payment.providerName, actualProvider: incomingProvider, providerPaymentId: payment.providerPaymentId },
    });
  }

  /**
   * PACKAGE B — remaining Codex blockers (audit recovery must be event-based). Reconstructs the
   * exact required transition audit from this event's OWN durable identity — `providerEventId` +
   * `fromStatus`/`toStatus` — never from whatever the payment's current status happens to be.
   * Idempotent per `(providerEventId, action)` (see `audit_event_provider_event_action_unique`): a
   * replay of an already-recorded transition returns the existing row rather than inserting a
   * second, chain-linked duplicate — safe to call unconditionally on every attempt, whether this is
   * the attempt that just applied the transition or a later retry restoring a previously-failed
   * audit write.
   */
  private async recordTransitionAudit(
    current: PaymentAttemptRecord,
    providerEventId: string,
    eventType: string,
    fromStatus: PaymentAttemptStatus,
    toStatus: PaymentAttemptStatus,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: current.payerProfileKind,
      profileId: current.payerProfileId,
      agreementId: current.agreementId,
      action: `payment_webhook_${eventType}`,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: fromStatus,
      newValue: toStatus,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_attempt",
      targetResourceId: current.id,
      providerEventId,
    });
  }

  /** SPRINT_19_FraudRisk_SecurityHardening §12: see this class's own doc comment for riskEvents (noncritical). */
  private async recordFailureRiskSignal(status: PaymentAttemptStatus, payment: PaymentAttemptRecord): Promise<void> {
    if (!this.deps.riskEvents || !this.deps.profileOwners || status !== "failed") return;
    try {
      const payerUserId = await this.deps.profileOwners.getOwnerUserId(payment.payerProfileKind, payment.payerProfileId);
      if (!payerUserId) return;
      await this.deps.riskEvents.recordSignal({
        userId: payerUserId,
        signalType: "repeated_payment_failure",
        severity: "low",
        outcome: "flagged",
        relatedResourceType: "payment_attempt",
        relatedResourceId: payment.id,
        detail: { agreementId: payment.agreementId },
      });
    } catch (error) {
      logger.error("risk_signal_record_failed", {
        signalType: "repeated_payment_failure",
        paymentAttemptId: payment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * PRSprint 18 / R09: only a "succeeded" transition can ever complete or activate an agreement.
   * REQUIRED — see this class's own doc comment; propagates failure rather than swallowing it.
   *
   * PACKAGE B — PRE-CODEX FINAL CORRECTION (item 3): marks THIS payment's own lifecycle effect as
   * examined immediately once `checkAndAdvance` returns without throwing — see
   * `markLifecycleChecked`'s own doc comment. This is what keeps the overwhelming happy-path majority
   * of succeeded payments out of `listLifecycleRepairCandidates` entirely; only a payment whose
   * examination never ran at all (this call never reached, e.g. a crash earlier in `applyEvent`)
   * remains eligible for the scheduler's own repair path to examine and mark.
   */
  private async checkCompletionRequired(status: PaymentAttemptStatus, payment: PaymentAttemptRecord): Promise<void> {
    if (!this.deps.completion || status !== "succeeded" || !payment.agreementId) return;
    await this.deps.completion.checkAndAdvance(payment.agreementId);
    await this.deps.payments.markLifecycleChecked(payment.id, new Date());
  }

  /** Sprint 17 review-pass addition — see the constructor's `notifications`/`profileOwners` doc comment (noncritical). */
  private async notifyPaymentStatus(status: PaymentAttemptStatus, payment: PaymentAttemptRecord): Promise<void> {
    if (!this.deps.notifications || !this.deps.profileOwners) return;
    const notificationType: NotificationEventType | null =
      status === "succeeded" ? "payment_cleared" : status === "disputed" ? "payment_disputed" : null;
    if (!notificationType) return;

    try {
      const [payerUserId, recipientUserId] = await Promise.all([
        this.deps.profileOwners.getOwnerUserId(payment.payerProfileKind, payment.payerProfileId),
        this.deps.profileOwners.getOwnerUserId(payment.recipientProfileKind, payment.recipientProfileId),
      ]);
      const recipients = [payerUserId, recipientUserId].filter((id): id is string => id !== null);
      await Promise.all(
        recipients.map((userId) =>
          this.deps.notifications!.notify({
            recipientUserId: userId,
            notificationType,
            relatedPaymentAttemptId: payment.id,
            relatedAgreementId: payment.agreementId,
            payload: { amountMinorUnits: payment.amountMinorUnits, currency: payment.currency },
            dedupeKey: `${notificationType}:${payment.id}:${userId}`,
          }),
        ),
      );
    } catch (error) {
      logger.error("payment_webhook_notification_failed", {
        paymentAttemptId: payment.id,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sprint 13 / R09: installment past_due/paid marking is schedule state material to correctness
   * (this remediation's own "installment/payment-schedule state needed for correctness" example) —
   * REQUIRED, not merely a notification trigger. Every underlying write here
   * (`markPastDue`/`markPaid`/`scheduleRetryForFailedPayment`/`cancelForInstallment`) is independently
   * idempotent (see failedPaymentWorkflowService.ts and paymentRetryService.ts's own doc comments),
   * so retrying this whole call on a later attempt is always safe.
   */
  private async runFailedPaymentWorkflowRequired(
    status: PaymentAttemptStatus,
    payment: PaymentAttemptRecord,
    failureCategory: string | null,
  ): Promise<void> {
    if (!this.deps.failedPaymentWorkflow || !payment.installmentScheduleItemId) return;
    if (status === "failed") {
      await this.deps.failedPaymentWorkflow.handlePaymentFailed(payment, failureCategory);
    } else if (status === "succeeded") {
      await this.deps.failedPaymentWorkflow.handlePaymentSucceeded(payment);
    }
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 6 targeted correction — exact-once supersession compensation).
   * Called from THIS event's own processing (only when `status` is one of
   * refunded/disputed/returned/reversed) — never from the stale success event's own retry path (its
   * `"superseded_safely"` disposition is, and remains, a pure no-op for workflow/lifecycle effects —
   * see `evaluateSuccessEffectDisposition`'s own doc comment). This is the ONLY trigger point that is
   * guaranteed to be reached: the ordinary production case is that the original success event already
   * fully processed once, cleanly, and is never claimed by `recoverBatch` again — so a compensation
   * hook that only fired on a stale-success RETRY would never run at all for the common case. Per the
   * transition matrix (`ALLOWED_SOURCE_STATUSES_FOR_DESTINATION`), whenever one of these four statuses'
   * OWN transition genuinely, durably applies, its source was always "succeeded" — so reaching this
   * call at all already IS the proof of supersession this needs; no separate check is required here.
   *
   * REQUIRED — installment schedule state material to correctness, same classification as
   * `runFailedPaymentWorkflowRequired`. Exact-once by construction: `FailedPaymentWorkflow
   * .handlePaymentSuperseded` (production: `FailedPaymentRetryCoordinator.coordinateSupersession`)
   * is keyed to THIS event's own stable `providerEventId` (`claimed.providerEventId`, always present
   * — `payment_webhook_event.provider_event_id` is `NOT NULL`, and `receiveInternalEvent`'s own
   * callers always mint a distinct synthetic one) — NEVER to `installment.status` alone. A retry of
   * this same event (redelivery, or recovery resuming a later required effect this event's own
   * processing left incomplete) durably detects its own prior compensation and never re-executes the
   * installment mutation, even if a different, later, legitimate payment has since changed the
   * installment's status — see that method's own doc comment for the exact defect this closes. Never
   * creates or resurrects a `payment_retry` row — approved architecture: the installment becomes
   * payable again, but a fresh charge only ever comes through the normal, explicitly authorized
   * payment flow, never an automatic recharge.
   */
  private async runSupersessionCompensationRequired(status: PaymentAttemptStatus, payment: PaymentAttemptRecord, providerEventId: string): Promise<void> {
    if (!this.deps.failedPaymentWorkflow || !payment.installmentScheduleItemId) return;
    if (status !== "refunded" && status !== "disputed" && status !== "returned" && status !== "reversed") return;
    await this.deps.failedPaymentWorkflow.handlePaymentSuperseded(payment, providerEventId);
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 6 blocking substage — post-success supersession compensation,
   * ARCHITECT DECISION). Same trigger point and rationale as `runSupersessionCompensationRequired`
   * (called immediately after it, so the agreement-level recompute below observes this installment's
   * own already-reopened state). `AgreementCompletionService.recomputeAfterSupersession` is the
   * ledger-authoritative recompute/demotion the Architect approved — never inferred from the
   * superseding event TYPE, only from live ledger/schedule truth; see that method's own doc comment
   * for the exact `paid_in_full`/`active`/`past_due`/`first_payment_pending` rules. Exact-once by the
   * same mechanism: it only ever writes when its own live recompute still shows a real change is due,
   * so a redelivery/replay that finds nothing left to change is a no-op.
   */
  private async checkSupersessionCompletionRequired(status: PaymentAttemptStatus, payment: PaymentAttemptRecord, providerEventId: string): Promise<void> {
    if (!this.deps.completion || !payment.agreementId) return;
    if (status !== "refunded" && status !== "disputed" && status !== "returned" && status !== "reversed") return;
    await this.deps.completion.recomputeAfterSupersession(payment.agreementId, providerEventId);
  }

  /**
   * R09: REQUIRED — see this class's own doc comment. Never swallows a posting failure; `LedgerService`'s
   * own idempotent get-or-post pattern makes a retry of this call always safe.
   *
   * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Items 2 & 4): a `source =
   * "provider_lookup"` event was NEVER signature-verified — unlike a real webhook (whose own
   * `parseWebhookEvent` normalization already guarantees `processorFeeMinorUnits` is an explicit
   * number for every "payment.succeeded" payload — see that method's own doc comment), its own
   * carried financial evidence must be independently validated — complete AND consistent with the
   * authoritative internal record — before ANY ledger entry is ever posted from it. A missing,
   * malformed, mismatched, or financially-impossible field throws the dedicated, explicitly-recognized
   * `ProviderLookupEvidenceError` (retryable/unresolved, per `classifyProcessingFailure` — see that
   * error's own doc comment for exactly why this is never `FinancialIntegrityError`) rather than
   * silently defaulting/fabricating — the event remains durably unresolved (not "processed") for
   * manual review/retry. `platformFeeMinorUnits` is NEVER sourced from either event's own payload for
   * the actual posting — it always comes from `platformFeePolicy`, the single centralized Paid2You
   * authority, for BOTH sources uniformly (Paid2You's own fee is never an external provider's or an
   * inbound webhook payload's to define).
   */
  private async postLedgerEntryRequired(
    eventType: string,
    payment: PaymentAttemptRecord,
    data: Record<string, unknown>,
    source: PaymentWebhookEventSource,
  ): Promise<void> {
    if (!payment.agreementId) {
      // PACKAGE B — FINAL NARROW CORRECTION (Codex blocker A): `PaymentService.submitToProvider` now
      // rejects every NEW provider-routed payment lacking an agreementId before it ever reaches a
      // provider — a payment reaching here with one is a pre-existing/legacy row only. Never silently
      // skip-and-mark-processed: that is exactly the defect Codex identified (a real provider success
      // whose required ledger accounting is skipped). Retryable, not permanent (`ConfigurationError`,
      // see `classifyProcessingFailure`) — remains visible/unresolved for manual review/backfill,
      // never a dead end, and never fabricates an agreement or a ledger entry to "fix" itself.
      throw new ConfigurationError("payment_webhook_ledger_blocked_no_agreement");
    }
    if (eventType === "payment.succeeded") {
      const authoritativePlatformFee = await this.platformFeePolicy.getPlatformFeeMinorUnits({
        amountMinorUnits: payment.amountMinorUnits,
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        agreementId: payment.agreementId,
      });
      if (source === "provider_lookup") {
        // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 4): every one of
        // these is a RETRYABLE `ProviderLookupEvidenceError` — never `FinancialIntegrityError`
        // (reserved for a genuinely impossible AUTHORITATIVE INTERNAL financial state, not merely
        // bad/incomplete evidence from an external lookup that a corrected provider-adapter
        // normalization could later resolve on retry).
        if (!isNonNegativeInteger(data.amountMinorUnits) || data.amountMinorUnits !== payment.amountMinorUnits) {
          throw new ProviderLookupEvidenceError("payment_provider_lookup_incomplete_or_mismatched_amount");
        }
        if (typeof data.currency !== "string" || data.currency !== payment.currency) {
          throw new ProviderLookupEvidenceError("payment_provider_lookup_incomplete_or_mismatched_currency");
        }
        if (!isNonNegativeInteger(data.processorFeeMinorUnits)) {
          throw new ProviderLookupEvidenceError("payment_provider_lookup_incomplete_processor_fee_evidence");
        }
        // PAID2YOU — PACKAGE B (Item 2 — CENTRALIZE PLATFORM-FEE AUTHORITY): the event's own carried
        // platformFeeMinorUnits (persisted by `resolveAmbiguousRetry` from this SAME policy, at
        // resolution time) must still be present, valid, AND consistent with what the policy says
        // right now — a mismatch means the evidence is stale/malformed, not a "missing field" the
        // actual posting below can simply override, so it is refused rather than silently corrected.
        if (!isNonNegativeInteger(data.platformFeeMinorUnits) || data.platformFeeMinorUnits !== authoritativePlatformFee) {
          throw new ProviderLookupEvidenceError("payment_provider_lookup_incomplete_or_mismatched_platform_fee");
        }
        if (data.processorFeeMinorUnits > data.amountMinorUnits) {
          throw new ProviderLookupEvidenceError("payment_provider_lookup_excessive_processor_fee");
        }
        if (data.platformFeeMinorUnits > data.amountMinorUnits) {
          throw new ProviderLookupEvidenceError("payment_provider_lookup_excessive_platform_fee");
        }
        if (data.processorFeeMinorUnits + data.platformFeeMinorUnits > data.amountMinorUnits) {
          throw new ProviderLookupEvidenceError("payment_provider_lookup_invalid_combined_fees");
        }
      }
      const processorFeeMinorUnits = typeof data.processorFeeMinorUnits === "number" ? data.processorFeeMinorUnits : 0;
      await this.deps.ledger.postPaymentCleared({
        paymentAttemptId: payment.id,
        agreementId: payment.agreementId,
        currency: payment.currency,
        grossAmountMinorUnits: payment.amountMinorUnits,
        processorFeeMinorUnits,
        // PAID2YOU — PACKAGE B (Item 2): ALWAYS the centralized policy's own value, for BOTH sources
        // — never read from either event's own payload for the actual posting.
        platformFeeMinorUnits: authoritativePlatformFee,
      });
      return;
    }
    const reversalEntryType = EVENT_TYPE_TO_REVERSAL_ENTRY[eventType];
    if (reversalEntryType) {
      const reason = typeof data.reason === "string" ? data.reason : null;
      await this.deps.ledger.reversePayment({ paymentAttemptId: payment.id, entryType: reversalEntryType, reason });
    }
  }

  /**
   * R09: REQUIRED — see this class's own doc comment. `markPayoutCompleted`'s own idempotency check
   * avoids re-stamping the completion timestamp on a retry.
   *
   * PACKAGE B — remaining Codex blockers (Section 5 — payout audit): the previous version returned
   * early whenever `payoutCompletedAt` was already set, which — exactly like the transition-audit gap
   * this mirrors — meant "financial effect timestamp committed, but its audit failed" left the
   * required audit permanently missing on every later retry. `payoutCompletedAt` alone only proves
   * the FINANCIAL effect applied; it says nothing about whether the audit effect did. The audit
   * record is now (re)ensured unconditionally — idempotent per `(providerEventId, action)`, so a
   * replay never duplicates it.
   */
  private async applyPayoutRequired(payment: PaymentAttemptRecord, providerEventId: string): Promise<void> {
    if (!payment.agreementId) {
      // Same rationale as postLedgerEntryRequired above — see its own doc comment.
      throw new ConfigurationError("payment_webhook_ledger_blocked_no_agreement");
    }
    await this.deps.ledger.postPayout({ paymentAttemptId: payment.id });
    const updated = payment.payoutCompletedAt ? payment : await this.deps.payments.markPayoutCompleted(payment.id, new Date());
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: updated.payerProfileKind,
      profileId: updated.payerProfileId,
      agreementId: updated.agreementId,
      action: "payment_webhook_payout.paid",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: updated.payoutCompletedAt,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_attempt",
      targetResourceId: updated.id,
      providerEventId,
    });
  }
}
