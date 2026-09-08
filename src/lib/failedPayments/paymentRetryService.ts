import "server-only";
import { DrizzleQueryError } from "drizzle-orm";
import type { AuditService } from "@/lib/audit/auditService";
import { logger } from "@/lib/logger";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentMethod } from "@/lib/payments/paymentService";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";
import type { PaymentInitiationEligibilityService } from "@/lib/payments/paymentInitiationEligibilityService";
import { addBusinessDays } from "./businessDays";
import type { FailedPaymentRetryCoordinator } from "./failedPaymentRetryCoordinator";

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4A): a fixed, bounded backoff applied
 * to a `claimed` retry whose `resolveAmbiguousRetry` attempt came back `still_ambiguous` (or
 * `not_applicable`, treated the same way defensively), so `findClaimedForResumption` defers it rather
 * than re-selecting the SAME permanently-stuck rows on every scheduler run. Deliberately fixed, not
 * exponential — see this fix's own final report for why.
 */
export const AMBIGUOUS_RETRY_RESOLUTION_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes.

/** "claimed" — PACKAGE B remaining Codex blockers: see FailedPaymentRetryCoordinator's own doc comment. */
export type PaymentRetryStatus = "scheduled" | "claimed" | "fired" | "canceled";

export interface PaymentRetryRecord {
  id: string;
  originalPaymentAttemptId: string;
  installmentScheduleItemId: string;
  agreementId: string;
  scheduledFor: Date;
  status: PaymentRetryStatus;
  resultingPaymentAttemptId: string | null;
  firedAt: Date | null;
  canceledAt: Date | null;
  canceledReason: string | null;
  createdAt: Date;
  /** PACKAGE B remaining Codex blockers — see FailedPaymentRetryCoordinator's own doc comment. */
  executionToken: string | null;
  /** PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4A): see the schema column's own doc comment. */
  nextResolutionAttemptAt: Date | null;
}

/** Real implementation: DrizzlePaymentRetryRepository. */
export interface PaymentRetryRepository {
  insert(input: {
    originalPaymentAttemptId: string;
    installmentScheduleItemId: string;
    agreementId: string;
    scheduledFor: Date;
  }): Promise<PaymentRetryRecord>;
  findByOriginalPaymentAttemptId(originalPaymentAttemptId: string): Promise<PaymentRetryRecord | null>;
  findByResultingPaymentAttemptId(resultingPaymentAttemptId: string): Promise<PaymentRetryRecord | null>;
  findScheduledForInstallment(installmentScheduleItemId: string): Promise<PaymentRetryRecord | null>;
  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4A): bounded (`limit`) and
   * deterministically ordered (`scheduledFor ASC, id ASC`) — Codex's own finding that this "remains
   * unbounded."
   */
  findDueForFiring(now: Date, limit: number): Promise<PaymentRetryRecord[]>;
  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4A). Retries left in `claimed`
   * status by an earlier attempt whose provider outcome came back ambiguous (request possibly
   * accepted, but the application never durably observed a resolved response) — see
   * `FailedPaymentRetryCoordinator.resolveAmbiguousRetry`'s own doc comment. Bounded (`limit`),
   * backoff-aware (`nextResolutionAttemptAt IS NULL OR <= now`), and deterministically ordered
   * (`nextResolutionAttemptAt ASC NULLS FIRST, id ASC`) — a permanently-ambiguous row's own backoff is
   * what stops it monopolizing every scheduler run forever, without ever permanently excluding it.
   */
  findClaimedForResumption(limit: number, now: Date): Promise<PaymentRetryRecord[]>;
  /** See `findClaimedForResumption`'s own doc comment — set after an INCONCLUSIVE resolution attempt (still ambiguous, or provider says not found). Cleared implicitly once resolved (the row then leaves `claimed` entirely). */
  markResolutionDeferred(id: string, nextAttemptAt: Date): Promise<void>;
  markFired(id: string, resultingPaymentAttemptId: string, firedAt: Date): Promise<PaymentRetryRecord>;
  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 3 — B3): conditional on the row
   * STILL being `scheduled` (`UPDATE ... WHERE id = ? AND status = 'scheduled'`) — never a blind
   * unconditional write. Returns `null` (never throws) when the row has already moved on to
   * `claimed`/`fired`/`canceled` by the time this runs (a concurrent worker claimed and possibly
   * dispatched it) — a stale scheduler snapshot's own cancellation attempt must be a safe no-op, never
   * an overwrite that destroys a possibly-dispatched attempt's outcome-discoverability.
   */
  markCanceled(id: string, canceledAt: Date, canceledReason: string): Promise<PaymentRetryRecord | null>;
}

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2): the narrow effect-application
 * capability `FailedPaymentRetryCoordinator.resolveAmbiguousRetry` needs to route a DISCOVERED,
 * definitive terminal provider outcome (succeeded/failed) through the SAME durable claim + required-
 * effect pipeline (legal transition validation, audit, ledger, installment workflow, agreement
 * lifecycle) a real webhook delivery uses — never a direct `payment_attempt.status` write. Structurally
 * satisfied by `PaymentWebhookService.receiveInternalEvent` (see that method's own doc comment) — this
 * interface is declared here, not imported from paymentWebhookService.ts, purely to avoid growing this
 * module's own import surface; any object exposing this one method works.
 */
export interface ProviderOutcomeEffectApplier {
  receiveInternalEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<{ status: "processed" | "duplicate" | "accepted" }>;
}

/** PAID2YOU — PACKAGE B (R06+R09 definitive implementation, Part XVIII): Node.js/postgres.js driver-level transport failure codes — a genuine DB-origin connection failure, distinct from a SQLSTATE (these never look SQLSTATE-shaped, so there is no overlap risk with the `08`/`53`/`57`/`58` classes below). See `node_modules/postgres/src/errors.js`'s own `connection()` error factory, which produces exactly these codes for a real socket-level failure. */
const DB_TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 5): inspects ONE node of a
 * cause chain (never traverses further itself) for either a genuine Postgres SQLSTATE fatal class or
 * a driver-level transport failure code. Split out from `isFatalInfrastructureError` so the recursive
 * chain-walker below stays a thin, obviously-terminating loop.
 */
function isDatabaseFatalSignal(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const code = (node as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  if (DB_TRANSPORT_FAILURE_CODES.has(code)) return true;
  // postgres.js's own driver-level error class (node_modules/postgres/src/errors.js) is not exported
  // as a stable top-level module export this repo can `instanceof`-check against directly (only
  // attached per-client-instance) — its own constructor sets `this.name = this.constructor.name`,
  // making `.name === "PostgresError"` a reliable, distinctive origin check, not a heuristic guess at
  // an arbitrary property's shape.
  if ((node as { name?: unknown }).name !== "PostgresError") return false;
  return ["08", "53", "57", "58"].some((prefix) => code.startsWith(prefix));
}

/**
 * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 5 — DATABASE-FATAL DETECTION
 * MUST TRAVERSE THE CAUSE CHAIN). Distinguishes a genuinely fatal, unsafe-to-continue infrastructure
 * condition (the database connection/backend itself failing) from an ordinary recoverable failure (a
 * provider lookup error, an application-level validation failure) — see
 * `PaymentRetryService.fireDueRetries`'s own doc comment for why the claimed-resumption loop must not
 * blanket-swallow this.
 *
 * Examining only a top-level `error.code`, or only the immediate `.cause`, is insufficient — it
 * misclassifies an ordinary provider/network error that merely happens to expose a coincidentally-
 * shaped `.code` string as database-fatal, while a REAL Drizzle/Postgres failure can wrap its
 * genuinely fatal signal several `.cause` links deep (a driver/pool wrapper around the raw
 * `postgres`-package error, for example) — drizzle-orm's pg-core session wraps EVERY underlying
 * driver error — a genuine SQLSTATE-bearing `PostgresError` from a server response, AND a raw
 * transport/socket failure that never reached the server at all — in one `DrizzleQueryError`, with
 * the original error (or a chain of wrappers around it) attached as `.cause` (see
 * node_modules/drizzle-orm/pg-core/session.js and node_modules/postgres/src/errors.js).
 *
 * This function first establishes DATABASE ORIGIN, then walks the ENTIRE cause chain:
 *   1. `error` must be `instanceof DrizzleQueryError` — the ONLY class drizzle-orm's own query
 *      execution path ever throws for a failed query. A provider/network/API error is never wrapped in
 *      this class, since it is never thrown from inside a Drizzle query execution — this alone already
 *      excludes every provider-origin error, however its own `.code` happens to be shaped (e.g. an
 *      ordinary provider adapter that itself throws a plain `Error` with `.code = "ECONNRESET"` is
 *      NEVER `instanceof DrizzleQueryError`, so it is correctly never classified as database-fatal —
 *      the presence of a matching code is never, by itself, sufficient without this outer origin gate).
 *   2. Given genuine database origin, `error.cause` and every `.cause` reachable from it are each
 *      inspected (`isDatabaseFatalSignal`) for either a genuine Postgres SQLSTATE fatal class (`08`/
 *      `53`/`57`/`58`, only when the node is genuinely a `PostgresError`) or a driver-level transport
 *      failure code (`ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EPIPE`/`ENETUNREACH`/`EHOSTUNREACH`,
 *      recognized by code alone — these never originate from a `PostgresError`, since the connection
 *      never reached far enough to get a server response at all). Traversal is protected against a
 *      malformed or circular cause chain by a visited-set (handles a cycle of any length, not merely
 *      an immediate self-reference) and a hard depth cap as a backstop.
 * Every other error (including any application-level `ValidationError`/`ConfigurationError` a provider
 * adapter or the effect pipeline might throw, and any provider error whose own `.code` happens to
 * collide with a SQLSTATE- or transport-shaped string) remains per-item recoverable.
 */
export function isFatalInfrastructureError(error: unknown): boolean {
  if (!(error instanceof DrizzleQueryError)) return false;
  const visited = new WeakSet<object>();
  let node: unknown = error.cause;
  let depth = 0;
  while (node && typeof node === "object" && depth < 20) {
    if (visited.has(node)) return false; // cycle detected — never seen as fatal, never loops forever.
    visited.add(node);
    if (isDatabaseFatalSignal(node)) return true;
    node = (node as { cause?: unknown }).cause;
    depth += 1;
  }
  return false;
}

/**
 * PAID2YOU — PACKAGE B (final retry-submission serialization): everything `RetryPaymentMethodInitiator
 * .prepareRetrySubmission` needs to determine BEFORE the installment lock is ever acquired — mandate/
 * card-on-file validity, and (for debit card) the fee-adjusted charge total. Deliberately read-only:
 * no DB write, no provider call, so it is always safe to run outside any lock.
 */
export interface PreparedRetrySubmission {
  amountMinorUnits: number;
  currency: string;
  paymentMethod: PaymentMethod;
  bankConnectionId: string | null;
}

/**
 * Whatever a payment method's own orchestration service (`AchPaymentService`/
 * `DebitCardPaymentService`) exposes for an ad-hoc payment — the retry's resulting charge is created
 * through this exact same gate any manual payment uses, never a separate/parallel path, matching
 * "never implement uncontrolled retries": a retry cannot bypass mandate/card-on-file/verification
 * checks that would otherwise apply.
 */
export interface RetryPaymentMethodInitiator {
  createManualPayment(input: {
    idempotencyKey: string;
    agreementId: string;
    payer: { profileKind: ProfileKind; profileId: string };
    recipient: { profileKind: ProfileKind; profileId: string };
    amountMinorUnits: number;
    currency: string;
    actingUserId: string;
    installmentScheduleItemId?: string;
    /**
     * PACKAGE B — PRE-CODEX FINAL CORRECTION (item 2): threaded all the way down to
     * `PaymentService.submitToProvider`, which awaits this as the ABSOLUTE LAST step before the real
     * provider call — see that method's own doc comment. `fireDueRetries` is the only caller that
     * ever supplies this; every other caller of `createManualPayment` omits it.
     */
    finalGuard?: () => Promise<void>;
  }): Promise<PaymentAttemptRecord>;
  /**
   * PAID2YOU — PACKAGE B (final retry-submission serialization). Runs every mandate/card-on-file
   * check (and, for debit card, the fee-adjusted charge computation) that `createManualPayment` would
   * otherwise run internally — but BEFORE any installment lock is acquired, never touching the
   * database or the provider itself. `FailedPaymentRetryCoordinator.claimAndExecuteRetry` uses the
   * result to submit directly, inside the locked transaction, without re-entering this initiator (or
   * `PaymentService`) at all — see that method's own doc comment for why the actual submission cannot
   * go through `createManualPayment`/`PaymentService.submitPending` once the lock is held (nested
   * `getDb()` transaction acquisition against the shared `max: 1` pooled connection would deadlock).
   * Throws (e.g. `ValidationError`) exactly like `createManualPayment` would if the method is
   * ineligible (mandate revoked, card expired/missing, no fee-allocation term).
   */
  prepareRetrySubmission(input: { agreementId: string; amountMinorUnits: number; currency: string }): Promise<PreparedRetrySubmission>;
}

/** Exported so `FailedPaymentRetryCoordinator`'s atomic path schedules with the exact same default this service uses. */
export const DEFAULT_RETRY_DELAY_BUSINESS_DAYS = 3;

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): schedules and fires the
 * single automatic retry a failed installment payment gets (FR-FAIL-003), and cancels it if a
 * manual payment clears the installment first. "Never implement uncontrolled retries" /
 * "if retry fails, stop automatic retries" is enforced two ways at once: `scheduleRetryForFailedPayment`
 * refuses to create a second `payment_retry` row for the same original attempt (checked via
 * `findByOriginalPaymentAttemptId`) AND refuses to schedule a retry *for a payment that is itself
 * already a retry's own result* (checked via `findByResultingPaymentAttemptId`) — so even if a
 * retry's own charge later fails, nothing re-enters this method for it. The unique DB index on
 * `payment_retry.original_payment_attempt_id` (src/db/schema/paymentRetry.ts) is the same guarantee
 * enforced a second, race-safe way, mirroring Sprint 9/11's idempotency-key precedent.
 */
export class PaymentRetryService {
  private readonly delayBusinessDays: number;

  constructor(
    private readonly deps: {
      retries: PaymentRetryRepository;
      paymentAttempts: PaymentAttemptRepository;
      initiators: Record<PaymentMethod, RetryPaymentMethodInitiator>;
      profileOwners: ProfileOwnerReader;
      audit: AuditService;
      delayBusinessDays?: number;
      /**
       * PACKAGE B — remaining Codex blockers (3B — retry executor coordination): optional, mirrors
       * `FailedPaymentWorkflowService.retryCoordinator`'s identical precedent. Real production wiring
       * always supplies it; `fireDueRetries` falls back to the plain (unfenced) sequence only for
       * in-memory-fake-based unit tests that never race firing against a concurrent success.
       */
      retryCoordinator?: FailedPaymentRetryCoordinator;
      /**
       * PAID2YOU — PACKAGE B (final retry-submission serialization): the SAME real provider instance
       * every payment method's own orchestration ultimately submits through (`getAchPaymentService`/
       * `getDebitCardPaymentService` both share `getPaymentService()`'s single provider) — handed
       * directly to `retryCoordinator.claimAndExecuteRetry` so it can call `provider.createPayment`
       * itself, inside the locked transaction, without re-entering `PaymentService`. Only required
       * when `retryCoordinator` is supplied.
       */
      provider?: PaymentProvider;
      /**
       * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1): the SAME reusable
       * eligibility layer `PaymentService.reserveAttempt` itself is built on — see that interface's
       * own doc comment. Only required when `retryCoordinator` is supplied.
       */
      eligibility?: PaymentInitiationEligibilityService;
      /**
       * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2): see
       * `ProviderOutcomeEffectApplier`'s own doc comment. Only required when `retryCoordinator` is
       * supplied — production wiring is `getPaymentWebhookService()`, the same singleton every real
       * webhook delivery already processes through.
       */
      effectApplier?: ProviderOutcomeEffectApplier;
    },
  ) {
    this.delayBusinessDays = deps.delayBusinessDays ?? DEFAULT_RETRY_DELAY_BUSINESS_DAYS;
  }

  async scheduleRetryForFailedPayment(payment: PaymentAttemptRecord, now: Date = new Date()): Promise<PaymentRetryRecord | null> {
    if (!payment.installmentScheduleItemId || !payment.agreementId) return null;

    const alreadyARetryResult = await this.deps.retries.findByResultingPaymentAttemptId(payment.id);
    if (alreadyARetryResult) return null; // this payment IS a retry's own charge — never re-retry it.

    const existing = await this.deps.retries.findByOriginalPaymentAttemptId(payment.id);
    if (existing) return existing; // idempotent replay of the same failure event.

    const scheduledFor = addBusinessDays(now, this.delayBusinessDays);
    const record = await this.deps.retries.insert({
      originalPaymentAttemptId: payment.id,
      installmentScheduleItemId: payment.installmentScheduleItemId,
      agreementId: payment.agreementId,
      scheduledFor,
    });

    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: payment.payerProfileKind,
      profileId: payment.payerProfileId,
      agreementId: payment.agreementId,
      action: "payment_retry_scheduled",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: scheduledFor.toISOString(),
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_retry",
      targetResourceId: record.id,
    });
    return record;
  }

  /** Requirement #7: "Cancel retry if manual payment succeeds." Idempotent no-op if nothing is scheduled. */
  async cancelForInstallment(installmentScheduleItemId: string, reason: string): Promise<void> {
    const scheduled = await this.deps.retries.findScheduledForInstallment(installmentScheduleItemId);
    if (!scheduled) return;
    const canceled = await this.deps.retries.markCanceled(scheduled.id, new Date(), reason);
    if (!canceled) return; // a concurrent worker already moved this row past "scheduled" — safe no-op.
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: null,
      profileId: null,
      agreementId: canceled.agreementId,
      action: "payment_retry_canceled",
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: null,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_retry",
      targetResourceId: canceled.id,
    });
  }

  /**
   * Sprint 18B: the failed-payment detail card's "scheduled retry date" —
   * authorized the same way PaymentService.retrievePayment authorizes a
   * single payment (payer or recipient of the *original* attempt), since
   * this class has no party-role concept of its own beyond that.
   */
  async findForOriginalPayment(originalPaymentAttemptId: string, actingUserId: string): Promise<PaymentRetryRecord | null> {
    const original = await this.deps.paymentAttempts.findById(originalPaymentAttemptId);
    if (!original) return null;
    const [payerOwner, recipientOwner] = await Promise.all([
      this.deps.profileOwners.getOwnerUserId(original.payerProfileKind, original.payerProfileId),
      this.deps.profileOwners.getOwnerUserId(original.recipientProfileKind, original.recipientProfileId),
    ]);
    if (payerOwner !== actingUserId && recipientOwner !== actingUserId) return null;
    return this.deps.retries.findByOriginalPaymentAttemptId(originalPaymentAttemptId);
  }

  /**
   * The cron-triggered batch entry point (`POST /api/scheduler/retry-failed-payments`) — Vercel has
   * no persistent worker process, so "firing" a due retry only happens when something calls this,
   * not from a timer this class itself owns. Each retry's own creation failure (e.g. the mandate/card
   * was revoked or replaced since the original failure) is caught per-row and the retry is marked
   * canceled with the reason recorded — a firing failure never retries itself on the next cron tick.
   */
  async fireDueRetries(now: Date = new Date(), limit = 200): Promise<{ fired: number; canceled: number; ambiguous: number; resolved: number }> {
    let fired = 0;
    let canceled = 0;
    let ambiguous = 0;
    let resolved = 0;

    if (this.deps.retryCoordinator) {
      if (!this.deps.provider) throw new Error("PaymentRetryService: 'provider' is required whenever 'retryCoordinator' is supplied.");
      if (!this.deps.eligibility) throw new Error("PaymentRetryService: 'eligibility' is required whenever 'retryCoordinator' is supplied.");
      if (!this.deps.effectApplier) throw new Error("PaymentRetryService: 'effectApplier' is required whenever 'retryCoordinator' is supplied.");
      const coordinator = this.deps.retryCoordinator;
      const provider = this.deps.provider;
      const eligibility = this.deps.eligibility;
      const effectApplier = this.deps.effectApplier;

      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2): a genuinely NEW attempt
      // (`scheduled`) and resuming an already-possibly-dispatched, ambiguous one (`claimed`) are TWO
      // DISTINCT operations, processed entirely separately — never through the same code path. Both
      // queries are bounded and deterministically ordered (Section 4A) — see their own doc comments.
      const dueScheduled = await this.deps.retries.findDueForFiring(now, limit);
      for (const retry of dueScheduled) {
        const original = await this.deps.paymentAttempts.findById(retry.originalPaymentAttemptId);
        if (!original || !original.paymentMethod) {
          logger.error("payment_retry_firing_failed", { paymentRetryId: retry.id, error: "original_payment_attempt_missing_or_no_method" });
          continue; // structurally unreachable in practice — never touches the installment lock either way.
        }
        const initiator = this.deps.initiators[original.paymentMethod];
        const payer = { profileKind: original.payerProfileKind, profileId: original.payerProfileId };
        const recipient = { profileKind: original.recipientProfileKind, profileId: original.recipientProfileId };

        try {
          // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1): `prepareRetrySubmission`
          // MUST run BEFORE any amount-dependent eligibility check — for debit card, it can compute a
          // `totalChargeMinorUnits` LARGER than `original.amountMinorUnits` (the borrower-surcharge
          // fee-allocation rule). Checking eligibility against the smaller base amount and then
          // dispatching the larger prepared one would let a retry pass transaction/daily limits using
          // an amount smaller than what actually gets charged — the exact defect Codex identified.
          // Mandate/card-on-file validity + (debit card) fee-adjusted charge — outside any lock.
          const prepared = await initiator.prepareRetrySubmission({
            agreementId: retry.agreementId,
            amountMinorUnits: original.amountMinorUnits,
            currency: original.currency,
          });
          // Section A — every control safe to run before any lock: kill switch, verification,
          // configured static/rolling limits. Mirrors PaymentService.reserveAttempt exactly — but
          // against the EXACT amount that will be dispatched (`prepared.amountMinorUnits`), never the
          // original, possibly-smaller one.
          await eligibility.assertPreLockEligible({ payer, recipient, amountMinorUnits: prepared.amountMinorUnits });

          const outcome = await coordinator.claimAndExecuteRetry({
            installmentScheduleItemId: retry.installmentScheduleItemId,
            retryId: retry.id,
            idempotencyKey: `retry-${retry.id}`,
            agreementId: retry.agreementId,
            provider,
            prepared,
            payer,
            recipient,
            effectApplier,
          });
          if (outcome.outcome === "fired") fired += 1;
          else if (outcome.outcome === "ambiguous") ambiguous += 1;
          else if (outcome.outcome === "failed") canceled += 1;
          // "not_claimable" (already settled/superseded by the time the lock was acquired) — no-op.
        } catch (error) {
          // Any pre-lock eligibility/preparation failure (prepareRetrySubmission,
          // assertPreLockEligible) — never touches the installment lock or the provider; the retry is
          // still merely "scheduled" here, so `markCanceled`'s conditional `WHERE status = 'scheduled'`
          // guard correctly cancels it below.
          //
          // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1): a throw FROM
          // `claimAndExecuteRetry` itself is a DIFFERENT case this SAME guard also correctly protects
          // against — by the time Phase A (`establishDurableDispatchIntent`) has committed, the retry
          // is already `claimed`, never `scheduled`, so ANY later failure (including a genuine
          // post-dispatch DB/commit fault Phase B's own transaction could not recover from) makes this
          // `markCanceled` call a guaranteed safe no-op — never erasing a possibly-already-dispatched
          // attempt's discoverability by mistakenly canceling it. This is never merely assumed: it is
          // the SAME conditional-UPDATE mechanism already relied on for the concurrent-claim race,
          // extended to cover this scenario by construction (see `establishDurableDispatchIntent`'s
          // own doc comment on why the durable claim commits BEFORE any provider call can occur).
          const reason = error instanceof Error ? error.message : "unknown_retry_preparation_error";
          logger.error("payment_retry_firing_failed", { paymentRetryId: retry.id, error: reason });
          const stillScheduled = await this.deps.retries.markCanceled(retry.id, now, `Firing failed: ${reason}`);
          if (stillScheduled) canceled += 1;
        }
      }

      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2): resumption NEVER re-runs
      // eligibility/prepareRetrySubmission and NEVER dispatches a new provider call — see
      // `resolveAmbiguousRetry`'s own doc comment for why re-authorizing here would be the exact
      // defect Codex identified (a revoked mandate/card must never cancel an already-dispatched,
      // unresolved external payment).
      //
      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 5): a per-item try/catch — a
      // single row's resolution failure (an ordinary provider/network/lookup error) must defer that
      // ONE row and continue to the next, never abort the whole batch (which would let a first,
      // permanently-stuck row silently starve every later row on every future run too). Only a
      // genuinely fatal, unsafe-to-continue infrastructure condition (see
      // `isFatalInfrastructureError`'s own doc comment) propagates out of this loop.
      const dueClaimed = await this.deps.retries.findClaimedForResumption(limit, now);
      for (const retry of dueClaimed) {
        try {
          const outcome = await coordinator.resolveAmbiguousRetry({ retryId: retry.id, idempotencyKey: `retry-${retry.id}`, provider, effectApplier });
          if (outcome.outcome === "fired") resolved += 1;
          // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1): "closed" means the retry is
          // ALREADY terminally `canceled` (never dispatched, or a same-key redispatch attempt was
          // itself definitively rejected) — it will never appear in `findClaimedForResumption` again
          // regardless, so no backoff bookkeeping is needed; only a genuinely still-unresolved outcome
          // (`still_ambiguous`/`not_applicable`) is deferred.
          else if (outcome.outcome !== "closed") await this.deps.retries.markResolutionDeferred(retry.id, new Date(now.getTime() + AMBIGUOUS_RETRY_RESOLUTION_BACKOFF_MS));
        } catch (error) {
          if (isFatalInfrastructureError(error)) throw error;
          const reason = error instanceof Error ? error.message : "unknown_retry_resolution_error";
          logger.error("payment_retry_resolution_failed", { paymentRetryId: retry.id, error: reason });
          await this.deps.retries.markResolutionDeferred(retry.id, new Date(now.getTime() + AMBIGUOUS_RETRY_RESOLUTION_BACKOFF_MS));
        }
      }

      return { fired, canceled, ambiguous, resolved };
    }

    // Fallback (no atomic coordinator wired) — see this class's own doc comment.
    const due = await this.deps.retries.findDueForFiring(now, limit);
    for (const retry of due) {
      try {
        const original = await this.deps.paymentAttempts.findById(retry.originalPaymentAttemptId);
        if (!original || !original.paymentMethod) {
          throw new Error("Original payment attempt not found or has no recorded payment method.");
        }
        const initiator = this.deps.initiators[original.paymentMethod];
        // System-initiated on the payer's behalf — every *Service.createManualPayment gate checks
        // `payerOwnerUserId === actingUserId` (PaymentService.reserveAttempt), so this must be the
        // payer profile's actual owning user id, never the profile id itself.
        const actingUserId = await this.deps.profileOwners.getOwnerUserId(original.payerProfileKind, original.payerProfileId);
        if (!actingUserId) {
          throw new Error("Could not resolve the payer profile's owning user.");
        }
        const resulting = await initiator.createManualPayment({
          idempotencyKey: `retry-${retry.id}`,
          agreementId: retry.agreementId,
          payer: { profileKind: original.payerProfileKind, profileId: original.payerProfileId },
          recipient: { profileKind: original.recipientProfileKind, profileId: original.recipientProfileId },
          amountMinorUnits: original.amountMinorUnits,
          currency: original.currency,
          actingUserId,
          // Keeps the retry's own resulting charge linked to the same installment — if this retry
          // itself later fails, the normal failure hook (mark past_due, notify) still applies to it,
          // while scheduleRetryForFailedPayment's own resultingPaymentAttemptId check prevents a
          // second payment_retry row from ever being created for it.
          installmentScheduleItemId: retry.installmentScheduleItemId,
        });
        await this.deps.retries.markFired(retry.id, resulting.id, now);
        fired += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown_retry_firing_error";
        logger.error("payment_retry_firing_failed", { paymentRetryId: retry.id, error: reason });
        const stillScheduled = await this.deps.retries.markCanceled(retry.id, now, `Firing failed: ${reason}`);
        if (stillScheduled) canceled += 1;
      }
    }
    return { fired, canceled, ambiguous, resolved };
  }
}
