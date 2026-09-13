import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, exists, inArray, isNull, like, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getServerEnv } from "@/config/env";
import { getDb, type Database } from "@/db/client";
import { agreement, agreementVersion, auditEvent, installmentScheduleItem, ledgerJournalEntry, ledgerPosting, partialPaymentRequest, paymentAttempt, paymentRetry } from "@/db/schema";
import { AuditService } from "@/lib/audit/auditService";
import { appendAuditEventTxBound, DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { computeAuditEventHash, type AuditEventPayload } from "@/lib/audit/hash";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import { isPastDate } from "@/lib/agreements/schedule";
import { reconstructPaidAndReversed } from "@/lib/ledger/balanceService";
import {
  assertInstallmentBelongsToAgreementWithinTx,
  assertNoCompetingUnresolvedInstallmentAttemptWithinTx,
  computeInstallmentSettlementWithinTx,
} from "@/lib/ledger/installmentSettlementTx";
import type { LedgerJournalEntryRecord } from "@/lib/ledger/ledgerService";
import { logger } from "@/lib/logger";
import type { PaymentAttemptRecord } from "@/lib/payments/paymentService";
import type { PaymentProvider, ProfileRef, RetrievePaymentResult } from "@/lib/payments/paymentProvider";
import { DefaultPlatformFeePolicy, type PlatformFeePolicy } from "@/lib/payments/platformFeePolicy";
import { addBusinessDays } from "./businessDays";
import { AMBIGUOUS_RETRY_RESOLUTION_BACKOFF_MS, DEFAULT_RETRY_DELAY_BUSINESS_DAYS, type PreparedRetrySubmission, type ProviderOutcomeEffectApplier } from "./paymentRetryService";

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1 — a bug found and fixed this
 * round). `claimAndExecuteRetry` MUST re-validate the overpayment control from INSIDE its own
 * transaction, using the SAME `tx` — never the externally-injected `PaymentInitiationEligibilityService`
 * (which is bound to the shared `getDb()` singleton). `getDb()`'s pool is `max: 1`
 * (Supavisor transaction-mode pooling — see that function's own doc comment): calling ANYTHING bound
 * to that same singleton from INSIDE an already-open transaction on it deadlocks forever (the inner
 * query needs a connection slot the outer transaction itself is holding). This function reuses the
 * EXACT SAME arithmetic `BalanceService`/`assertNotOverpaying` use (`reconstructPaidAndReversed`,
 * imported, never re-implemented) but reads its inputs via `tx`-bound queries.
 */
async function computeRemainingBalanceMinorUnitsWithinTx(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  agreementId: string,
): Promise<number | null> {
  const agreementRows = await tx.select({ currentVersionId: agreement.currentVersionId }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
  const agreementRow = agreementRows[0];
  if (!agreementRow?.currentVersionId) return null;
  const versionRows = await tx
    .select({ terms: agreementVersion.terms })
    .from(agreementVersion)
    .where(eq(agreementVersion.id, agreementRow.currentVersionId))
    .limit(1);
  const versionRow = versionRows[0];
  if (!versionRow) return null;
  const principalMinorUnits = (versionRow.terms as AgreementTerms).currentPrincipalMinorUnits;

  const entryRows = await tx.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.agreementId, agreementId));
  const entries: LedgerJournalEntryRecord[] = [];
  for (const entryRow of entryRows) {
    const postingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
    entries.push({
      id: entryRow.id,
      entryType: entryRow.entryType,
      agreementId: entryRow.agreementId,
      paymentAttemptId: entryRow.paymentAttemptId,
      currency: entryRow.currency,
      reason: entryRow.reason,
      createdAt: entryRow.createdAt,
      postings: postingRows.map((p) => ({ id: p.id, accountId: p.accountId, accountType: p.accountType, direction: p.direction, amountMinorUnits: p.amountMinorUnits })),
    });
  }
  const { amountPaidMinorUnits } = reconstructPaidAndReversed(entries);
  return principalMinorUnits - amountPaidMinorUnits;
}

/**
 * R11 (INSTALLMENT AMOUNT-AWARENESS — PAYMENT INITIATION CEILING): the narrower, per-installment
 * counterpart to `computeRemainingBalanceMinorUnitsWithinTx`'s agreement-level overpayment guard —
 * see this class's own top-level doc comment for why a retry's own re-dispatch must also respect the
 * installment's own remaining amount, not merely the agreement's aggregate balance (a retry is a new
 * charge attempt against one specific installment; the agreement-level check alone cannot see that
 * ANOTHER contribution has since covered most of THIS installment while other installments still have
 * headroom). Must be called AFTER the installment row's own `FOR UPDATE` lock is held in this same
 * transaction — every call site below already establishes that lock earlier in the same `tx`.
 * Throws `ValidationError` (never returns a boolean) so every call site fails the SAME way
 * `computeRemainingBalanceMinorUnitsWithinTx`'s own inline check already does, for one consistent
 * error shape across both ceilings.
 */
async function assertWithinInstallmentCeilingWithinTx(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  installmentScheduleItemId: string,
  requestedAmountMinorUnits: number,
): Promise<void> {
  const settlement = await computeInstallmentSettlementWithinTx(tx, installmentScheduleItemId);
  if (!settlement) return; // installment row not found — nothing to bound against (defensive only).
  if (requestedAmountMinorUnits > settlement.remainingMinorUnits) {
    throw new ValidationError(
      `This payment of ${requestedAmountMinorUnits} minor units would exceed this installment's remaining amount of ${settlement.remainingMinorUnits} minor units. Overpayment against a single installment is not permitted.`,
    );
  }
}

/**
 * PAID2YOU — PACKAGE B (final retry-submission serialization). Thrown by a `PaymentProvider` (or, in
 * tests, a wrapper around one) to signal "the request may or may not have reached/been accepted by
 * the processor — the application never durably observed a resolved response" (a network timeout, a
 * connection reset after the request was sent, etc.) — distinct from every other thrown error, which
 * `claimAndExecuteRetry` treats as a DEFINITE rejection. Real provider adapters should throw this
 * specifically for their own "ambiguous" failure modes (timeout, 5xx with no parseable body, etc.);
 * `SandboxPaymentProvider` never throws it on its own (it has no real network layer to lose a response
 * over) — this session's `R-B40-STRICT-C` models it via a thin call-counting wrapper, exactly the way
 * `flaky()` elsewhere in this codebase's test suite models a definite failure.
 */
export class AmbiguousProviderResponseError extends Error {
  constructor(message = "ambiguous_provider_response") {
    super(message);
    this.name = "AmbiguousProviderResponseError";
  }
}

/**
 * "scheduled" (never touched) and "claimed" (a worker owns it) — but see `coordinateSuccess`'s own
 * doc comment (Section 3 — B3 fix): a "claimed" retry is cancelable ONLY when no `submitted`
 * `payment_attempt` row exists for it yet. "claimed" covers TWO structurally different sub-states
 * that happen to share one status value:
 *   (1) the legacy two-phase `claimRetryForExecution` claim — a worker owns the retry but has not
 *       yet (and may never) call the provider; no `payment_attempt` row exists for it at all. This
 *       MUST remain cancelable (R-B40/R-B41/R-B42/R-B40-STRICT's own accepted invariant: a claim
 *       revoked before the provider call must make `confirmExecutionStillValid` report false).
 *   (2) `claimAndExecuteRetry`'s own ambiguous-outcome claim — the provider call was ACTUALLY
 *       attempted and may have succeeded externally; a `submitted` `payment_attempt` row already
 *       exists, keyed by `retry-${id}`. This must NEVER be canceled (Codex's Section 3 finding) —
 *       doing so would remove it from `findClaimedForResumption` forever, permanently losing the only
 *       path that can ever correlate/resolve that already-dispatched attempt.
 */
const CANCELABLE_RETRY_STATUSES = ["scheduled", "claimed"] as const;

export type CoordinateFailureResult =
  /** The installment was already "paid" (settled by a later attempt) by the time the lock was acquired — no past_due write, no retry, this stale failure is a pure no-op. */
  | { outcome: "already_settled" }
  | {
      outcome: "retry_scheduled";
      retryId: string;
      /** true if a retry for this exact original payment attempt already existed (idempotent replay) — the caller must not re-record a "scheduled" audit entry for it. */
      alreadyExisted: boolean;
    };

/**
 * PAID2YOU — PACKAGE B (Codex final review — durably record BOTH compensation dispositions): the
 * two mutually-exclusive, durable `audit_event.action` values `coordinateSupersession` can record
 * for a given `providerEventId` — never both for the same event (the branch that decides which one
 * to write is taken at most once, ever, per event; see that method's own doc comment). Distinct
 * action strings, not a single shared one, so `(providerEventId, action)`'s existing unique index
 * keys them independently and a durable "no reopen was required" conclusion is exactly as
 * crash-safe/exact-once as a durable "reopened" one — closing the gap where only the "reopened"
 * outcome had a durable marker and a "not_paid" determination could be silently re-evaluated later
 * against a since-changed (and by then unrelated) installment status.
 */
const INSTALLMENT_REOPENED_ACTION = "installment_reopened_by_supersession";
const INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION = "installment_reopen_not_required_by_supersession";

/**
 * R11: both "no reopen required" sub-cases (`"not_paid"` and `"still_satisfied"`) share the single
 * `INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION` durable marker — this recovers which one it was, from the
 * marker's own already-persisted `newValue.disposition`, so a replayed/retried call of the exact same
 * `providerEventId` reports the identical outcome it would have on first evaluation, never
 * re-deriving it from (possibly since-changed) live installment evidence.
 */
function notRequiredDispositionOutcome(newValue: unknown): "not_paid" | "still_satisfied" | "waived_preserved" {
  const disposition = (newValue as { disposition?: unknown } | null)?.disposition;
  if (disposition === "still_satisfied") return "still_satisfied";
  if (disposition === "waived_preserved") return "waived_preserved";
  return "not_paid";
}

/**
 * PAID2YOU — PACKAGE B (Stage 6 targeted correction — exact-once supersession compensation). Result
 * of `coordinateSupersession` — see that method's own doc comment.
 */
export type CoordinateSupersessionResult =
  /**
   * This EXACT superseding event (`providerEventId`) had already durably compensated this
   * installment on a prior attempt — proven by the existing `installment_reopened_by_supersession`
   * audit marker for `(providerEventId, action)`, never inferred from `installment.status`. The
   * installment row was never read or touched this call — see `coordinateSupersession`'s own doc
   * comment for exactly why this is the correction's whole point.
   */
  | { outcome: "already_compensated" }
  /**
   * This EXACT superseding event durably determined — either just now, or on a prior attempt (a
   * `installment_reopen_not_required_by_supersession` audit marker for `(providerEventId, action)`
   * proves it) — that the installment was not "paid" and so had nothing to compensate. This
   * disposition is itself durable and exact-once: a later attempt of this SAME event never
   * re-examines `installment.status` again, regardless of what legitimately changes it afterward
   * (e.g. the success that would have marked it paid never ran, or a materially different situation
   * this correction does not attempt to characterize — see the PRE-EXISTING INSTALLMENT
   * AMOUNT-AWARENESS GAP recorded in this class's own doc comment).
   */
  | { outcome: "not_paid" }
  /**
   * R11 (INSTALLMENT AMOUNT-AWARENESS): this reversal was durably determined — either just now, or
   * on a prior attempt of this SAME `providerEventId` — to leave the installment STILL amount-
   * satisfied (another, still-valid contribution's own money already covers the full
   * `amount_minor_units` on its own). Distinct from `"not_paid"` (the installment was never
   * satisfied in the first place) purely for audit/observability clarity — both share the exact same
   * durable `installment_reopen_not_required_by_supersession` marker and the exact same "no mutation,
   * no reopen" behavior.
   */
  | { outcome: "still_satisfied" }
  /**
   * R11 PASS B1 — FINAL TARGETED CORRECTION (Defect 2 — WAIVED INSTALLMENT REOPENED BY
   * coordinateSupersession). This EXACT superseding event durably determined — either just now, or
   * on a prior attempt (the SAME `installment_reopen_not_required_by_supersession` audit marker,
   * `newValue.disposition = "waived_preserved"`) — that the installment's cached status was
   * `"waived"` at the moment this event was decided. `"waived"` is an explicit, durable business
   * disposition (an authorized party forgave this installment) — a refund/reversal/dispute on the
   * payment that happened to fund it is never, by itself, evidence that the waiver itself should be
   * revoked. Preserved UNCONDITIONALLY: never reopened to scheduled/past_due, never re-derived from
   * authoritative settlement (a shortfall after this reversal is not a charge trigger for an
   * installment nothing is charging), and never mutated by any of `coordinateSuccess`/
   * `coordinateFailure`/`claimRetryForExecution` either — mirrors `coordinateFailure`'s own identical
   * "paid"/"waived" preservation guard (see that method's own doc comment) for this class's other
   * mutating entry point. Only a future, explicit waiver-revocation workflow (not part of R11) may
   * ever change a waived installment's status — never an automatic side effect of ordinary
   * success/failure/refund/reversal/dispute/supersession processing.
   */
  | { outcome: "waived_preserved" }
  | { outcome: "reopened"; newStatus: "scheduled" | "past_due" };

/**
 * PACKAGE B — FINAL NARROW CORRECTION (Codex blocker 7 residual race). `FailedPaymentWorkflowService`
 * previously read `installments.findStatus(...)` and only THEN separately decided whether to mark
 * past_due and schedule a retry — a genuine TOCTOU window: a concurrent `handlePaymentSucceeded` for
 * the SAME installment could commit in between, and this stale failure would still mark it past_due
 * and/or schedule a pointless retry.
 *
 * This class closes that window with a single Postgres transaction per installment, using
 * `SELECT ... FOR UPDATE` to hold a real row lock on the installment for the ENTIRE decide-and-act
 * sequence — never a separate read then a separate write. `coordinateSuccess` (the
 * `handlePaymentSucceeded` counterpart) takes the SAME row lock before writing "paid" and
 * cancelling any scheduled retry, so the two paths can never interleave for the same installment:
 * whichever transaction acquires the lock first fully completes (commits) before the other's lock
 * request is even granted, and the second one then re-reads the ALREADY-COMMITTED authoritative state.
 *
 * Retry identity/idempotency reuses the EXACT same mechanism `PaymentRetryService
 * .scheduleRetryForFailedPayment` already uses (`payment_retry.original_payment_attempt_id`'s unique
 * index, plus the `resulting_payment_attempt_id` self-retry guard) — this is the same retry
 * architecture, just executed inside the installment's own lock instead of as a separate, unlocked
 * call.
 *
 * Optional on `FailedPaymentWorkflowService` (mirrors `AuditEventRepository.appendAtomically`'s
 * identical precedent): every real production wiring supplies it; in-memory-fake-based unit tests
 * that never race `handlePaymentFailed`/`handlePaymentSucceeded` against each other fall back to the
 * simpler, non-atomic sequence, which remains correct for those single-threaded-in-effect tests.
 *
 * PACKAGE B — remaining Codex blockers (3B — retry executor coordination, design rationale):
 * `PaymentRetryService.fireDueRetries` must not let a retry a `coordinateSuccess` has already
 * canceled still reach `provider.createPayment`. This class deliberately chooses OPTION B (durable
 * execution fencing) over OPTION A (holding the installment lock through the actual provider call):
 * holding a DB row lock across an external network round-trip would let one slow/hung provider call
 * block every other operation on that installment (including a legitimate concurrent success) for
 * the duration of that call — an unacceptable blast radius for what is otherwise a narrow,
 * infrequent retry path. Instead: `claimRetryForExecution` atomically claims the retry under the
 * installment lock (closing the bulk of the race — see R-B40), and `confirmExecutionStillValid` is a
 * MANDATORY final, unlocked read of the latest committed state immediately before the provider call
 * (see that method's own doc comment). This narrows the residual race to the gap between that read
 * and the actual network call — the same class of irreducible residual every external-provider
 * integration has (no in-process lock can fence an already-in-flight HTTP request), and far
 * narrower than the original "read due retries once, then act minutes/seconds later" window.
 */
export type ClaimForExecutionResult =
  | { outcome: "claimed"; executionToken: string }
  /** The installment is already settled, or the retry is no longer in a claimable state (already claimed/fired/canceled) — never executable. */
  | { outcome: "not_claimable" };

/**
 * PAID2YOU — PACKAGE B (final retry-submission serialization). Result of `claimAndExecuteRetry` — see
 * that method's own doc comment.
 */
export type ExecuteRetryResult =
  /** The provider call completed and resolved to a real payment_attempt — `resultingPaymentAttemptId` is authoritative. */
  | { outcome: "fired"; resultingPaymentAttemptId: string }
  /**
   * The provider request may or may not have been accepted — the application never durably observed
   * a resolved response (see `AmbiguousProviderResponseError`). The retry remains `claimed`
   * (never `fired`, never `canceled`) and `paymentAttemptId` names the row this attempt created (or
   * found already existing from an earlier ambiguous attempt) — recovery must resume from EXACTLY
   * this row via the SAME `idempotencyKey`, never create a second one, and must never mark the
   * installment paid on this outcome alone.
   */
  | { outcome: "ambiguous"; paymentAttemptId: string }
  /** The provider (or a local precondition) definitely rejected the submission — the retry is canceled. */
  | { outcome: "failed"; reason: string }
  /** The installment was already settled, or this retry is no longer in a claimable state, by the time the lock was acquired — the provider was NEVER called. */
  | { outcome: "not_claimable" };

/** PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2). Result of `resolveAmbiguousRetry` — see that method's own doc comment. */
export type ResolveAmbiguousResult =
  /** The provider (or a locally-adopted earlier resolution) confirmed a real outcome — persisted, retry marked fired. */
  | { outcome: "fired"; resultingPaymentAttemptId: string }
  /** The provider has no record of this idempotency key (or the lookup itself is inconclusive) — still unresolved; retry remains `claimed`, deferred by backoff. */
  | { outcome: "still_ambiguous" }
  /** This retry is not (or no longer) in a state resolution applies to (not `claimed`, or no matching `submitted` payment_attempt row exists) — a no-op. */
  | { outcome: "not_applicable" }
  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1 — PROVIDER LOOKUP RETURNS NOT
   * FOUND). The provider definitively confirmed no record of this idempotency key exists, AND the
   * local intent was safely closed WITHOUT ever dispatching — either the installment was already
   * settled by another payment (`resolveNotFoundOutcome`'s own doc comment), or a fresh eligibility
   * re-check (overpayment) itself refused, or a REdispatch attempt using the SAME key was definitively
   * rejected by the provider. Terminal: the retry is `canceled`, never left `claimed` for a future
   * resolution attempt to reconsider.
   */
  | { outcome: "closed" };

export interface FailedPaymentRetryCoordinator {
  coordinateFailure(input: { installmentScheduleItemId: string; payment: PaymentAttemptRecord }): Promise<CoordinateFailureResult>;
  /**
   * PACKAGE B — remaining Codex blockers (3A — success must cancel ALL executable retries): cancels
   * EVERY retry in a cancelable state (`scheduled` or `claimed`) for this installment — never just
   * one — via a single bounded, set-based UPDATE while holding the installment lock. Multiple failed
   * attempts for the same installment can each have created their own retry (uniqueness is per
   * ORIGINAL payment attempt, not per installment), so "cancel one" was never sufficient. Returns
   * every canceled retry's id.
   *
   * R11 (INSTALLMENT AMOUNT-AWARENESS — ARCHITECT-APPROVED DESIGN, closing the gap this class's own
   * doc comment used to record as open): under the SAME installment lock, recomputes the
   * installment's authoritative net contribution (`computeInstallmentSettlementWithinTx`) and marks
   * "paid" — and cancels pending retries — ONLY when that net contribution is >=
   * `amount_minor_units`. A payment that only PARTIALLY satisfies the installment never marks it
   * "paid" and never cancels a still-legitimate pending retry for the remainder; the installment's
   * status is instead set to `scheduled`/`past_due` per its own due date, exactly like
   * `coordinateFailure`'s existing rule. No new durable marker is needed for the "not yet satisfied"
   * branch: recomputing fresh evidence under this same lock on every call is naturally idempotent and
   * can never regress a genuinely, currently-satisfied installment back to unpaid — only
   * `coordinateSupersession` (a real reversal) can ever legitimately demote a "paid" installment, and
   * that path has its own durable, providerEventId-correlated marker (see its own doc comment).
   */
  coordinateSuccess(input: { installmentScheduleItemId: string }): Promise<{ canceledRetryIds: string[]; installmentSatisfied: boolean }>;
  /**
   * PAID2YOU — PACKAGE B (Stage 6 targeted correction — exact-once supersession compensation, per
   * ChatGPT's own required Case C fix). `PaymentWebhookService` calls this when a
   * `payment.disputed`/`refunded`/`returned`/`reversed` event's OWN transition durably proves it just
   * superseded a "succeeded" payment (see `PaymentWebhookService.runSupersessionCompensationRequired`'s
   * own doc comment for exactly when this fires — the superseding event's OWN processing, never the
   * stale success event's retry, so this is reached even in the ordinary case where the original
   * success event already fully processed and will never be revisited).
   *
   * CASE C FIX — `installment.status === "paid"` is NEVER, by itself, sufficient proof that THIS
   * event's compensation has not already run: a required-effect retry (e.g. this event's own later
   * agreement recompute failing and being retried) re-enters this method, and by that later attempt a
   * genuinely NEW, unrelated, legitimate payment could have re-paid the installment in the interim —
   * `status === "paid"` at that point proves the installment is validly paid again, not that THIS
   * event has never compensated it. The authoritative, durable idempotency signal is instead: does an
   * `installment_reopened_by_supersession` audit row already exist for `(providerEventId, action)` —
   * `providerEventId` is THIS event's own stable, `NOT NULL`, globally-scoped-per-provider identity
   * (`payment_webhook_event.provider_event_id`), non-null for every event this method is ever called
   * for, webhook-delivered or internally-resolved alike (`receiveInternalEvent`'s callers always mint
   * one explicitly — see that method's own doc comment). This reuses the EXACT SAME
   * `audit_event_provider_event_action_unique` index and dedup semantics `recordTransitionAudit`
   * already relies on for its own idempotency — no new mechanism, no new table, no migration.
   *
   * ATOMICITY AND ORDERING (mandatory — Codex final concurrency re-review; see this method's own
   * implementation comment): the installment row lock (`FOR UPDATE`) is acquired FIRST — before the
   * authoritative marker check, never after — and the marker check, the installment mutation, and the
   * marker's own durable insert all happen afterward, inside that SAME transaction, still holding
   * that same lock. This ordering is the actual mutual-exclusion boundary: two overlapping workers
   * processing the SAME superseding event both attempt this row lock, but Postgres grants it to only
   * one at a time — the second genuinely blocks until the first's transaction commits or rolls back,
   * then re-acquires the lock and re-reads the marker fresh, guaranteed to observe whatever the first
   * worker just committed. Checking the marker BEFORE the lock (an earlier, defective version of this
   * method) let two overlapping workers both observe "no marker yet" and then both proceed to decide
   * — by the time either worker's decision was made, the lock had never actually serialized anything.
   * A pre-transaction marker lookup is still an allowed OPTIMIZATION (skip opening a transaction/
   * acquiring the row lock at all when the common case — already compensated — is true) — it is never
   * itself the correctness gate; only the post-lock check inside the transaction is authoritative.
   * There is no window where the installment can be mutated without the marker committing alongside
   * it, no window where a marker can exist without the mutation (or non-mutation) decision that
   * produced it, and — because both disposition branches are reached only from after this same lock
   * acquisition, and are mutually exclusive within one call — no way for both
   * `installment_reopened_by_supersession` and `installment_reopen_not_required_by_supersession` to
   * ever be durably recorded for the same `providerEventId`.
   *
   * Same installment row lock as `coordinateFailure`/`coordinateSuccess` — a concurrent
   * `coordinateSuccess`/`coordinateFailure`/`coordinateSupersession` for the SAME installment can
   * never interleave with this. Never creates a `payment_retry` row and never touches an existing one
   * — approved architecture: the installment becomes payable again, but a fresh charge only ever comes
   * through the normal, explicitly authorized payment flow, never an automatic recharge after a
   * dispute/refund/return/reversal. Reopens to "scheduled" (due date not yet passed) or "past_due"
   * (already passed), per the installment's own `due_date` — reuses the existing
   * `installment_item_status` vocabulary; no new enum value.
   *
   * R11 (INSTALLMENT AMOUNT-AWARENESS — ARCHITECT-APPROVED DESIGN, closing the gap this doc comment
   * used to record as open): the disposition below is now decided from the installment's
   * authoritative, tx-bound NET contribution (`computeInstallmentSettlementWithinTx`, joined through
   * the immutable `payment_attempt.installment_schedule_item_id` link) — NEVER from
   * `installment.status` alone. If, after this reversal's own ledger effect (already posted before
   * this method is ever called — see `PaymentWebhookService`'s dispatch ordering), the installment
   * remains fully covered by other still-valid contributions, no reopen happens (`"still_satisfied"`)
   * even though a naive status-only check might have found "paid" and reopened it incorrectly. If the
   * net contribution now falls short, the installment reopens to `scheduled`/`past_due` exactly as
   * before. Both "no reopen needed" outcomes (`"not_paid"` and `"still_satisfied"`) share the same
   * durable `installment_reopen_not_required_by_supersession` marker — see this method's own
   * implementation for why one marker correctly covers both.
   */
  coordinateSupersession(input: {
    installmentScheduleItemId: string;
    payment: PaymentAttemptRecord;
    /** The superseding event's own stable identity — see this method's own doc comment for why this, never installment.status, is the idempotency correlation key. */
    providerEventId: string;
  }): Promise<CoordinateSupersessionResult>;
  /**
   * PACKAGE B — remaining Codex blockers (3B — retry executor coordination). Atomically, under the
   * SAME installment lock `coordinateFailure`/`coordinateSuccess` use: confirms the installment is
   * not settled, confirms the retry is still `scheduled`, and claims it (`status = "claimed"`, a
   * fresh `executionToken`) — so a concurrent `coordinateSuccess` for the same installment either
   * blocks behind this claim (and then cancels the now-`claimed` retry once it proceeds) or has
   * already committed (in which case this claim correctly reports `not_claimable`).
   */
  claimRetryForExecution(input: { installmentScheduleItemId: string; retryId: string }): Promise<ClaimForExecutionResult>;
  /**
   * The mandatory final authorization check — see this class's own doc comment for why this, not the
   * initial claim alone, is what a worker must consult IMMEDIATELY before calling the provider. A
   * plain (unlocked) read of the latest committed state: if `coordinateSuccess` canceled this retry
   * since it was claimed, this returns `false` and the worker must never call the provider.
   */
  confirmExecutionStillValid(input: { retryId: string; executionToken: string }): Promise<boolean>;
  /** Fenced by `executionToken` — a stale/superseded claim's own call is a silent no-op, mirroring `PaymentWebhookEventRepository.markProcessed`'s identical claim-token precedent. */
  markRetryFired(input: { retryId: string; executionToken: string; resultingPaymentAttemptId: string; firedAt: Date }): Promise<void>;
  /** Fenced by `executionToken` — see `markRetryFired`'s own doc comment. */
  markRetryExecutionFailed(input: { retryId: string; executionToken: string; canceledReason: string }): Promise<void>;
  /**
   * PAID2YOU — PACKAGE B (final retry-submission serialization; Stage 9 remediation, Root
   * Corrections 1 & 2) — THE authoritative execution path, now a TWO-PHASE protocol:
   *
   * PHASE A — DURABLE INTENT (`establishDurableDispatchIntent`, its own short, independently
   * committed transaction): claims the retry (`scheduled` -> `claimed`) and inserts the
   * `payment_attempt` row (`status = "submitted"`, keyed by the stable `idempotencyKey =
   * retry-${retryId}`) — a durable, committed DISCOVERY ANCHOR that survives ANY later failure,
   * including a crash or a commit failure in Phase B, because it is a SEPARATE, already-committed
   * transaction by the time Phase B (or the real provider call) ever runs. Before this fix, the claim
   * and the payment_attempt insert lived in the SAME transaction as the provider call itself — a
   * provider call that succeeds externally while THAT transaction's own later commit fails would
   * erase the claim and the row together, leaving no durable trace for any future scheduler run to
   * ever look for that external payment again. Stable idempotency at the PROVIDER alone was never
   * sufficient — it only prevents duplicate creation; it does nothing to guarantee Paid2You ever asks
   * again.
   *
   * PHASE B — SERIALIZED PROVIDER DISPATCH (`dispatchProviderCallForAnchor`, a SEPARATE transaction
   * that only ever runs after Phase A's anchor is already durably committed): re-acquires the
   * installment row lock, revalidates (not settled, overpayment), and calls the real
   * `provider.createPayment` using the SAME idempotency key — the lock is acquired ONCE and held for
   * the entire remainder of THIS transaction, through the provider call, through persisting
   * correlation, all the way to commit — mirroring the prior single-transaction design's own
   * mutual-exclusion guarantee against `coordinateSuccess` (see that method's own doc comment),
   * just now scoped to Phase B alone rather than the whole call. If Phase B's own transaction fails to
   * commit for ANY reason AFTER the provider call was attempted (a genuine DB fault, not a definite
   * provider rejection) the Phase-A anchor remains committed and the retry remains `claimed` — never
   * silently reverted to `scheduled` and re-canceled as an ordinary preparation failure (see
   * `PaymentRetryService.fireDueRetries`'s own doc comment on why a thrown error here must never
   * trigger `markCanceled`).
   *
   * TERMINAL RESULTS NEVER WRITE TERMINAL STATUS DIRECTLY (Root Correction 2): a NON-terminal
   * (`pending`) `createPayment` response may be persisted conditionally (`submitted -> processing`).
   * A TERMINAL response (`succeeded`/`failed`) is NEVER written to `payment_attempt.status` from here
   * — only its `providerPaymentId` correlation is persisted, and Phase B's transaction commits with
   * the row still `submitted`. Immediately afterward (same call, after commit), the authoritative
   * outcome is obtained via a FRESH `provider.retrievePaymentByIdempotencyKey` call — never merely
   * trusting `createPayment`'s own synchronous response shape, which would be pretending an
   * unauthenticated dispatch response is equivalent to a signed webhook — and routed through
   * `effectApplier.receiveInternalEvent`, the EXACT SAME durable claim + required-effect pipeline
   * (`PaymentTransitionCoordinator`, audit, ledger, `FailedPaymentWorkflow`,
   * `AgreementCompletionService`) a real webhook or `resolveAmbiguousRetry` uses — see
   * `resolveAmbiguousRetry`'s own doc comment, which this method's post-dispatch step shares via
   * `resolveSubmittedAnchor`.
   *
   * Never re-enters `PaymentService`/`AchPaymentService`/`DebitCardPaymentService.createManualPayment`
   * — those internally perform their OWN separate DB reads/writes against the shared `getDb()`
   * singleton (`max: 1`, transaction-mode pooled), and calling into them from inside an already-open
   * transaction on that same singleton would deadlock (the inner call has no free connection to
   * acquire). Instead, `prepared` (from `RetryPaymentMethodInitiator.prepareRetrySubmission`, run
   * BEFORE this method is ever called, entirely outside any lock) carries everything needed to build
   * the payment_attempt row directly, and `provider.createPayment` is called directly, not through
   * `PaymentService`.
   *
   * Idempotency: `idempotencyKey` (always `retry-${retryId}`, minted once at schedule time and never
   * regenerated) is looked up FIRST, inside Phase A's own lock, before any insert. An existing row
   * found this way (Phase A re-entry, or a genuinely already-dispatched anchor) is adopted, never
   * duplicated — see `establishDurableDispatchIntent`'s own doc comment.
   *
   * Claims ONLY from `scheduled` — a genuinely NEW attempt. Resuming a `claimed` retry whose provider
   * outcome came back ambiguous is a DISTINCT, separate operation (`resolveAmbiguousRetry`) that never
   * re-runs eligibility/mandate/card checks or calls `provider.createPayment` again — see Codex's own
   * finding (Section 2) for why re-running new-payment authorization as the first step of resuming an
   * already-possibly-dispatched attempt is itself a defect (a card/mandate revoked AFTER dispatch must
   * never cause an already-in-flight external payment to be canceled before its outcome is known).
   *
   * The overpayment control is re-validated in PHASE B, immediately before `provider.createPayment`,
   * while the installment lock is held — the agreement's outstanding balance can change from a
   * DIFFERENT, concurrently-completing payment. Computed via `tx`-bound queries INSIDE that same
   * transaction (reusing `reconstructPaidAndReversed`'s exact arithmetic — never a second,
   * independently-drifting copy of the policy) — NEVER by calling the externally-injected
   * `PaymentInitiationEligibilityService` from inside this transaction: that service's dependencies
   * are bound to the shared `getDb()` singleton, and `getDb()`'s pool is `max: 1` — calling anything
   * bound to that same singleton from inside an already-open transaction on it deadlocks forever. Every
   * OTHER eligibility control (kill switch, verification, static limits) is the caller's responsibility
   * to check BEFORE ever calling this method — see `PaymentRetryService.fireDueRetries`.
   */
  claimAndExecuteRetry(input: {
    installmentScheduleItemId: string;
    retryId: string;
    idempotencyKey: string;
    agreementId: string;
    provider: PaymentProvider;
    prepared: PreparedRetrySubmission;
    payer: ProfileRef;
    recipient: ProfileRef;
    /**
     * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 2): required so a TERMINAL
     * provider result discovered during dispatch can be routed through the SAME durable
     * `receiveInternalEvent` pipeline `resolveAmbiguousRetry` uses — see this method's own doc
     * comment. Production wiring is the SAME `getPaymentWebhookService()` singleton
     * `resolveAmbiguousRetry`'s own callers already supply.
     */
    effectApplier: ProviderOutcomeEffectApplier;
  }): Promise<ExecuteRetryResult>;
  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2) — THE distinct ambiguity-recovery
   * path. Never runs `prepareRetrySubmission`/eligibility checks, never calls `provider.createPayment`
   * — it can only ASK the provider, via `provider.retrievePaymentByIdempotencyKey`, what (if anything)
   * it already knows about this exact `idempotencyKey`. Does NOT hold the installment lock across that
   * read (unlike `claimAndExecuteRetry`) — there is no NEW external dispatch here for the lock to
   * protect against; a `coordinateSuccess` that cancels this retry concurrently does not retroactively
   * undo an external submission that may have already happened, and this method's own `payment_retry`
   * write is fenced by the retry's OWN current `executionToken`, read fresh, exactly like
   * `markRetryFired`/`markRetryExecutionFailed`.
   *
   * Found (provider recognizes the key): persists `providerPaymentId` onto the existing `submitted`
   * `payment_attempt` row (so a future webhook can correlate to it) — a pure identity-correlation
   * write, always safe regardless of any concurrent status race. The DISCOVERED outcome itself is
   * NEVER applied as a direct status write (PAID2YOU — PACKAGE B, Codex final remaining blockers,
   * Section 2 — B2 fix: Codex's own finding that a direct write here can regress a status a concurrent
   * real webhook has already legally advanced, or leave the payment's required ledger/audit/
   * installment/lifecycle effects permanently unapplied even though its status looks terminal):
   *   - a TERMINAL outcome (succeeded/failed) is routed through `effectApplier.receiveInternalEvent`
   *     — the EXACT SAME durable claim + required-effect pipeline (legal transition validation, audit,
   *     ledger, installment workflow, agreement lifecycle) a real webhook delivery uses, keyed by a
   *     synthetic `providerEventId` distinct from any real one. A later real webhook for the SAME
   *     outcome is safely rejected as a dead no-op by the existing legal-transition matrix — never a
   *     duplicate effect (see `PaymentWebhookService.applyEvent`'s own doc comment).
   *   - a NON-terminal outcome ("pending") only ever advances `submitted -> processing`, and only
   *     CONDITIONALLY (`WHERE status = 'submitted'`) — never regressing/overwriting a status a
   *     concurrent real webhook has already legally advanced past "submitted".
   * Marks the retry `fired` on ANY non-null outcome (terminal or not) — mirroring
   * `claimAndExecuteRetry`'s own "fired" semantics: it means "a definite response was durably obtained
   * from the provider", not "the payment has definitively settled". Never creates a second
   * payment_attempt row.
   *
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1 — PROVIDER LOOKUP RETURNS NOT
   * FOUND): a durable intent does NOT prove dispatch actually occurred, so "not found" is no longer
   * blindly treated as "still unresolved, try again later forever." See `resolveNotFoundOutcome`'s
   * own doc comment for the exact recheck-and-decide protocol — the outcome is one of: `fired` (a
   * SAME-key redispatch succeeded and its outcome was resolved), `still_ambiguous` (a same-key
   * redispatch attempt itself came back ambiguous — genuinely try again later), or `closed` (the
   * installment was already settled by another payment, or a fresh eligibility/overpayment check
   * itself refused, or the redispatch was definitively rejected — the retry is terminally `canceled`,
   * never left `claimed`).
   */
  resolveAmbiguousRetry(input: {
    retryId: string;
    idempotencyKey: string;
    provider: PaymentProvider;
    effectApplier: ProviderOutcomeEffectApplier;
  }): Promise<ResolveAmbiguousResult>;
  /**
   * R11 PASS B1 — FINAL LEGACY RECOVERY CORRECTION (Defect 2). Bounded repair pass for `fired`
   * retries whose replacement lineage/partial-payment application may not have completed — see this
   * method's own implementation doc comment. Intended to be invoked from an existing reconciliation
   * entry point, never a new unbounded scheduler.
   *
   * R11 PASS B1 — SURGICAL FINAL PATCH (Part 1C/1D): `now` (defaults to `new Date()`) is the same
   * backoff-eligibility clock `nextResolutionAttemptAt` is compared against — threaded through so
   * `ReconciliationService.repairBatch`'s own `now` is reused rather than a second, independently
   * drifting clock.
   */
  repairLegacyRetryLineage(limit?: number, now?: Date): Promise<{ scanned: number }>;
}

/**
 * PACKAGE B — FINAL NARROW CORRECTION: the same kind of production-safe, no-op-by-default test-only
 * affordance as `AgreementLockTestHooks` (see `drizzleSigningApplicationRepository.ts`'s own doc
 * comment) — lets a `*.postgres.test.ts` suite pause a real transaction the instant it genuinely
 * holds the installment row lock, long enough to deterministically prove the other side is really
 * blocked behind it, without any sleep-based timing assumption. Both default to `undefined`; every
 * production call site (`new DrizzleFailedPaymentRetryCoordinator()`, no second argument) never sets
 * them, so this can never run, or even be checked, outside a test.
 */
export interface InstallmentLockTestHooks {
  /** Awaited immediately after the installment row lock has been GRANTED — from this point until the hook resolves, this transaction is genuinely holding that lock. */
  afterInstallmentLock?: () => Promise<void>;
  /**
   * R11 CORRECTION PASS A (Defect A3 — AGREEMENT/INSTALLMENT DEADLOCK CYCLE): awaited by
   * `establishDurableDispatchIntent` (Phase A of retry dispatch) immediately after the NEW `agreement`
   * row lock has been GRANTED — before the installment row is ever locked. See this class's own
   * top-level doc comment (and `DrizzleInstallmentAwarePaymentReserver`'s identical addition) for the
   * exact lock-order cycle this closes.
   *
   * R11 PASS A — FINAL TARGETED CORRECTION (Defect 2 — coordinateFailure LOCK-ORDER INVERSION): also
   * awaited by `coordinateFailure`, at the identical point — immediately after ITS OWN new `agreement`
   * row lock has been GRANTED, before the installment row is ever locked. See `coordinateFailure`'s
   * own doc comment for the exact lock-order cycle this closes.
   */
  afterAgreementLock?: () => Promise<void>;
  /**
   * PAID2YOU — PACKAGE B (Codex final concurrency re-review): awaited by `coordinateSupersession`
   * genuinely INSIDE its own open transaction, immediately BEFORE it issues the
   * `SELECT ... FOR UPDATE` that acquires the installment row lock — i.e. before this worker has
   * taken (or even attempted) that lock at all. Lets a `*.postgres.test.ts` suite deterministically
   * pause exactly one overlapping worker at that point, let a SECOND, genuinely concurrent worker
   * process the SAME superseding event to completion (acquire the lock, decide a disposition, commit,
   * release), and only then resume the first — proving the first worker's own post-lock disposition
   * re-check (never a pre-lock one) is what correctly observes the second worker's already-committed
   * decision, per this method's own doc comment.
   */
  beforeInstallmentLock?: () => Promise<void>;
  /**
   * PAID2YOU — PACKAGE B (final retry-submission serialization): awaited by `claimAndExecuteRetry`
   * as the literal last step before the real `provider.createPayment` call — deterministic proof
   * that the installment lock is STILL held that late (not merely right after acquisition), for
   * `R-B40-STRICT-B`'s own required scenario.
   */
  beforeProviderCall?: () => Promise<void>;
  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Corrections 1 & 2). Awaited immediately AFTER
   * `provider.createPayment` (or a redispatch attempt from `resolveNotFoundOutcome`) has genuinely
   * returned a real response, but BEFORE that response's correlation/non-terminal status is persisted
   * — deterministic proof that a genuine DB/persistence fault occurring in exactly this window (the
   * provider call already definitely succeeded; only the local bookkeeping afterward fails) is a
   * POST-DISPATCH / OUTCOME-UNKNOWN failure, never a definite rejection: if this hook throws, that
   * throw propagates out of Phase B's transaction (which rolls back) exactly like a real commit
   * failure would, while Phase A's own already-committed durable anchor remains untouched and still
   * discoverable — see `dispatchProviderCallForAnchor`'s own doc comment.
   */
  afterProviderCallBeforePersist?: () => Promise<void>;
  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 2). Awaited by `claimAndExecuteRetry`
   * immediately AFTER Phase B's own transaction has COMMITTED (correlation/non-terminal status
   * durably persisted) but BEFORE the post-commit authoritative resolution step
   * (`resolveSubmittedAnchor`) runs — deterministic proof of "a process crash between persisting the
   * provider result and actually applying its required effects": if this hook throws, the anchor is
   * left exactly as Phase B committed it (`submitted`, correlated), and a LATER, independent
   * `resolveAmbiguousRetry` call (modeling the scheduler's own automatic resumption after restart)
   * must still discover and correctly complete it.
   */
  afterDispatchCommitBeforeResolution?: () => Promise<void>;
}

/**
 * R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 1B). Narrow, consumer-defined view — same
 * interface-segregation precedent as `ProviderOutcomeEffectApplier` above. Real implementation:
 * `PartialPaymentAutoApplicationService`. Declared here, not imported from that module, for the same
 * reason `paymentWebhookService.ts`'s own identical `PartialPaymentApplication` interface is
 * declared locally rather than imported.
 */
export interface PartialPaymentApplicationForRepair {
  applyClearedPayment(
    paymentAttemptId: string,
  ): Promise<{ outcome: "applied" | "already_applied" | "not_correlated" | "not_yet_durable" | "conflict" }>;
}

/**
 * R11 PASS B1 — FINAL CORRECTION (Defect 3 — REPAIR MUST RETURN AN EXPLICIT DISPOSITION). Every
 * caller of `repairLegacyLineageAndApply` MUST inspect this — see that method's own doc comment and
 * each call site's own handling for exactly what each disposition permits/forbids.
 */
export type LegacyLineageRepairOutcome =
  /** The link and/or the proposal application were successfully repaired just now. */
  | { kind: "repaired" }
  /** The required effect was already fully satisfied before this call — a safe, successful no-op. */
  | { kind: "already_complete" }
  /** Conclusively unrelated/nothing to repair — proven, never merely assumed. */
  | { kind: "not_applicable" }
  /** The required effect is still incomplete but genuinely retryable later — never terminal, never a conflict. */
  | { kind: "deferred" }
  /** Durable contradictory-data evidence was recorded; nothing was mutated, adopted, or applied. */
  | { kind: "conflict" };

/**
 * R11 PASS B1 — SURGICAL FINAL PATCH (Part 3/4 — SPLIT IDENTITY ADOPTION FROM PROPOSAL
 * APPLICATION). Result of `validateAndAdoptLegacyReplacement` — see that method's own doc comment.
 * Identity-only: never implies anything about whether a partial-payment proposal was applied.
 */
export type LegacyIdentityAdoptionResult =
  /** `resultingPaymentAttemptId` was `NULL` and has just now been atomically set to the candidate. */
  | { kind: "adopted" }
  /** `resultingPaymentAttemptId` already equalled the candidate — a safe, idempotent no-op. */
  | { kind: "already_adopted" }
  /** Durable contradictory-data evidence was recorded; nothing was mutated or adopted. */
  | { kind: "conflict" }
  /** Conclusively unrelated/nothing to adopt against — proven, never merely assumed. */
  | { kind: "not_applicable" };

export class DrizzleFailedPaymentRetryCoordinator implements FailedPaymentRetryCoordinator {
  constructor(
    private readonly db: Database = getDb(),
    private readonly delayBusinessDays: number = DEFAULT_RETRY_DELAY_BUSINESS_DAYS,
    private readonly audit: AuditService = new AuditService(new DrizzleAuditEventRepository()),
    private readonly hooks?: InstallmentLockTestHooks,
    // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 2 — CENTRALIZE PAID2YOU
    // PLATFORM-FEE AUTHORITY): this retry/ambiguity subsystem must NEVER define Paid2You pricing
    // policy itself — `resolveAmbiguousRetry` obtains `platformFeeMinorUnits` exclusively from this
    // injected policy, the SAME one `PaymentWebhookService`'s normal webhook-receipt ledger posting
    // uses. Defaults to `DefaultPlatformFeePolicy` (today's actual authoritative rule: explicit zero)
    // so every pre-existing test/production call site is unaffected — the default IS the real
    // production behavior, not a test-only stand-in.
    private readonly platformFeePolicy: PlatformFeePolicy = new DefaultPlatformFeePolicy(),
    // R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 1 — LEGACY/IN-FLIGHT REPLACEMENT LINEAGE REPAIR):
    // optional so every pre-existing test/production call site that never wires this is unaffected.
    // Used ONLY by the "already resolved" adoption branches (`dispatchProviderCallForAnchor`,
    // `resolveNotFoundOutcome`) — see `repairLegacyLineageAndApply`'s own doc comment.
    private readonly partialPaymentApplication?: PartialPaymentApplicationForRepair,
  ) {}

  /**
   * R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 1A/1B). Called ONLY from an "already resolved"
   * adoption branch — i.e. this exact anchor attempt had ALREADY moved past `"submitted"` by the
   * time this coordinator looked at it again (resolved by an earlier attempt of this SAME retry, or
   * by an independently-arriving real webhook). `markRetryFiredIfClaimed`'s own `status = 'claimed'`
   * fence is a safe no-op once the retry has already moved past `"claimed"` (exactly this case) — so
   * for a row from BEFORE `establishDurableDispatchIntent`'s Phase-A write existed,
   * `resultingPaymentAttemptId` could otherwise stay permanently `null`. Repairs it directly here,
   * conditioned ONLY on it currently being `NULL` (never overwrites an existing, potentially
   * different value — `anchor` here is ALWAYS the trusted, correct attempt for this retry, already
   * established via Phase A's own idempotencyKey-matched lookup, so there is nothing further to
   * "validate" before trusting it).
   *
   * Then (1B): if a partial-payment application service is wired and this attempt already has
   * durable `payment_cleared` evidence, invokes the SAME idempotent application effect directly —
   * this is what provides recovery even when the webhook event that would normally trigger it is
   * already `processed` and thus ineligible for `recoverBatch`. Best-effort: never propagates a
   * failure here (this is a side effect of an UNRELATED retry-coordination call whose own return
   * value is about the RETRY's own outcome, not partial-payment application) — logged and swallowed;
   * the normal webhook/recoverBatch path remains the primary, always-eventually-consistent mechanism.
   */
  /**
   * R11 PASS B1 — FINAL LEGACY RECOVERY CORRECTION (Defects 1/3/4/5). Extended beyond the original
   * "write resultingPaymentAttemptId if null, then apply" version with two mandatory checks BEFORE
   * either write:
   *
   * IDENTITY VALIDATION (Defect 4/5): `candidateAttemptId` is trusted only if it genuinely belongs
   * to THIS retry — its own idempotencyKey must be the exact deterministic `retry-<retryId>` form
   * (never a coincidental arbitrary attempt), AND its agreementId/installmentScheduleItemId must
   * match the retry row's own recorded ownership context. A trusted key that disagrees with that
   * context (Defect 5's "agreement/installment mismatch" case) is rejected with durable conflict
   * evidence, never repaired, never applied, never a provider call.
   *
   * CONTRADICTORY LINEAGE (Defect 4): if `resultingPaymentAttemptId` is ALREADY set to a DIFFERENT
   * attempt than the validated candidate, that is never overwritten and the candidate is never
   * silently applied instead — a durable conflict is recorded and this call returns. Only a NULL
   * existing value may be repaired to the validated candidate; an existing value equal to the
   * candidate is a safe, idempotent no-op that proceeds straight to the application step.
   *
   * DURABLE FAILURE RECOVERY (Defect 3): a thrown/failed application attempt is logged but otherwise
   * never needs a bespoke "pending repair" flag — the correlated partial-payment proposal's OWN
   * `awaiting_payment` status is already the durable signal that repair is still owed, and
   * `repairLegacyRetryLineage`'s own bounded rescan (never filtered on `resultingPaymentAttemptId`
   * nullness — see that method's own doc comment) naturally retries it on its next pass, via the
   * SAME idempotent `applyClearedPayment` primitive, without ever relying on the original success
   * webhook event (which may already be `processed` and thus ineligible for `recoverBatch`).
   */
  private async repairLegacyLineageAndApply(retryId: string, candidateAttemptId: string): Promise<LegacyLineageRepairOutcome> {
    // R11 PASS B1 — SURGICAL FINAL PATCH (Part 3 — SPLIT IDENTITY ADOPTION FROM PROPOSAL
    // APPLICATION): identity/link validation is now owned entirely by `validateAndAdoptLegacyReplacement`
    // — the SAME helper `resolveAmbiguousRetry`'s own SUBMITTED-candidate path (Part 5) reuses — never
    // a second, independently-diverging implementation.
    const adoption = await this.validateAndAdoptLegacyReplacement(retryId, candidateAttemptId);
    if (adoption.kind === "not_applicable") return { kind: "not_applicable" };
    if (adoption.kind === "conflict") return { kind: "conflict" };
    // "adopted" or "already_adopted" — the link is now trustworthy; proceed to the historical-
    // clearing/application portion, which this method alone still owns.

    if (!this.partialPaymentApplication) return { kind: "already_complete" }; // nothing more this coordinator can determine — every production wiring supplies this.
    try {
      const applyOutcome = await this.partialPaymentApplication.applyClearedPayment(candidateAttemptId);
      switch (applyOutcome.outcome) {
        case "applied":
          return { kind: "repaired" };
        case "already_applied":
          return { kind: "already_complete" };
        case "not_correlated":
          return { kind: "not_applicable" };
        case "conflict":
          // R11 PASS B1 — SURGICAL FINAL PATCH (Part 1B — APPLICATION CONFLICT MUST LEAVE THE SCAN):
          // `applyClearedPayment` already recorded its OWN `partial_payment_request`-scoped conflict
          // evidence (Defect 4A) — that alone does NOT exclude this retry from
          // `repairLegacyRetryLineage`'s own selector, which only checks for a `payment_retry`-scoped
          // marker. Record that SAME retry-scoped family here (`payment_retry_legacy_lineage_conflict_
          // application`) so this row durably and permanently leaves every future fired-scan batch,
          // exactly like every other legacy-repair conflict — never a second, diverging conflict
          // *record type*, just the retry-level marker the selector itself actually looks for.
          await this.recordLegacyRepairConflict(retryId, candidateAttemptId, "application", candidateAttemptId);
          return { kind: "conflict" };
        case "not_yet_durable":
        default:
          return { kind: "deferred" };
      }
    } catch (error) {
      // R11 PASS B1 — FINAL CORRECTION (Defect 7 — TRANSIENT FAILURE MUST REMAIN RECOVERABLE): a
      // genuine, retryable failure (DB hiccup, transient application-service error) — logged, never
      // durably recorded as a conflict (this is not contradictory data, just a failed attempt), and
      // classified `deferred` so the caller never treats this as resolved/terminal.
      //
      // R11 PASS B1 — SURGICAL FINAL PATCH (Part 1C — TRANSIENT DEFERRED REPAIR MUST BACK OFF): also
      // persists a future eligibility time on the EXISTING durable `nextResolutionAttemptAt` field —
      // the SAME column the claimed-resumption scheduler already uses for its own backoff (no new
      // schema column) — so `repairLegacyRetryLineage`'s own selector temporarily excludes this row
      // instead of letting it permanently monopolize every future bounded batch.
      logger.error("failed_payment_retry_coordinator_legacy_application_repair_failed", {
        retryId,
        paymentAttemptId: candidateAttemptId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.db
        .update(paymentRetry)
        .set({ nextResolutionAttemptAt: new Date(Date.now() + AMBIGUOUS_RETRY_RESOLUTION_BACKOFF_MS) })
        .where(eq(paymentRetry.id, retryId));
      return { kind: "deferred" };
    }
  }

  /**
   * R11 PASS B1 — SURGICAL FINAL PATCH (Part 3/4 — SPLIT IDENTITY ADOPTION FROM PROPOSAL
   * APPLICATION). The ONLY place this coordinator validates and (atomically, null-or-same) durably
   * links a candidate replacement attempt to a retry's own `resultingPaymentAttemptId` — reused by
   * `repairLegacyLineageAndApply` (the fired-scan/already-resolved terminal path) AND by
   * `resolveAmbiguousRetry`'s own SUBMITTED-candidate resumption (Part 5), so there is exactly one
   * implementation of this identity/link logic, never two independently-diverging copies.
   *
   * Purely identity/link validation: never calls the provider, never applies a partial-payment
   * proposal, never posts a ledger entry, never creates a payment attempt or a retry.
   *
   * IDENTITY VALIDATION (Defect 4/5/6, unchanged from the prior round): `candidateAttemptId` is
   * trusted only if it genuinely belongs to THIS retry — the retry's own `originalPaymentAttemptId`
   * must coherently belong to the SAME agreement/installment context this retry row itself records
   * (checked FIRST, before any candidate is even considered), and the candidate's own idempotencyKey
   * must be the exact deterministic `retry-<retryId>` form with matching agreement/installment
   * ownership. Either mismatch is rejected with durable conflict evidence, never adopted.
   *
   * ATOMIC NULL-OR-SAME LINK WRITE (Defect 5, unchanged): a single conditional UPDATE enforces
   * "NULL -> candidate, or already == candidate" at the database level — never a separate
   * read-then-write race window a concurrent writer could exploit.
   */
  private async validateAndAdoptLegacyReplacement(retryId: string, candidateAttemptId: string): Promise<LegacyIdentityAdoptionResult> {
    const retryRows = await this.db.select().from(paymentRetry).where(eq(paymentRetry.id, retryId)).limit(1);
    const retryRow = retryRows[0];
    if (!retryRow) return { kind: "not_applicable" }; // defensive only — never expected in practice.

    const originalRows = await this.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, retryRow.originalPaymentAttemptId)).limit(1);
    const original = originalRows[0];
    if (!original || original.agreementId !== retryRow.agreementId || original.installmentScheduleItemId !== retryRow.installmentScheduleItemId) {
      await this.recordLegacyRepairConflict(retryId, candidateAttemptId, "original_attempt_context_mismatch", retryRow.resultingPaymentAttemptId);
      return { kind: "conflict" };
    }

    const candidateRows = await this.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, candidateAttemptId)).limit(1);
    const candidate = candidateRows[0];
    if (!candidate) return { kind: "not_applicable" }; // conclusively nothing to adopt against.

    const identityValid =
      candidate.idempotencyKey === `retry-${retryId}` &&
      candidate.agreementId === retryRow.agreementId &&
      candidate.installmentScheduleItemId === retryRow.installmentScheduleItemId;
    if (!identityValid) {
      await this.recordLegacyRepairConflict(retryId, candidateAttemptId, "identity_mismatch", retryRow.resultingPaymentAttemptId);
      return { kind: "conflict" };
    }

    const wasAlreadySame = retryRow.resultingPaymentAttemptId === candidateAttemptId;
    // `OR resultingPaymentAttemptId = candidateAttemptId` makes an already-correct link's own repeat
    // write a genuine no-op affecting zero *meaningfully differing* rows while still reporting
    // success (the WHERE still matches, so `.returning()` still yields a row).
    const [written] = await this.db
      .update(paymentRetry)
      .set({ resultingPaymentAttemptId: candidateAttemptId })
      .where(and(eq(paymentRetry.id, retryId), or(isNull(paymentRetry.resultingPaymentAttemptId), eq(paymentRetry.resultingPaymentAttemptId, candidateAttemptId))))
      .returning({ resultingPaymentAttemptId: paymentRetry.resultingPaymentAttemptId });
    if (written) return { kind: wasAlreadySame ? "already_adopted" : "adopted" };

    // Zero rows affected — a concurrent writer won first. Re-read fresh, authoritative state and
    // classify same-vs-conflicting; never assume the write succeeded.
    const freshRows = await this.db.select({ resultingPaymentAttemptId: paymentRetry.resultingPaymentAttemptId }).from(paymentRetry).where(eq(paymentRetry.id, retryId)).limit(1);
    const freshResultingId = freshRows[0]?.resultingPaymentAttemptId ?? null;
    if (freshResultingId !== candidateAttemptId) {
      await this.recordLegacyRepairConflict(retryId, candidateAttemptId, "contradictory_resulting_attempt", freshResultingId);
      return { kind: "conflict" };
    }
    // A concurrent writer already set it to THIS same candidate — idempotent success.
    return { kind: "already_adopted" };
  }

  /** Defect 4/5 — durable, deduplicated conflict evidence for a legacy-lineage repair that could NOT safely proceed. Deduped on `(targetResourceType, targetResourceId, action, conflictType)` via the candidate attempt id folded into the audit payload key check, mirroring `PartialPaymentAutoApplicationService.hasExistingAuditRecord`'s own precedent. */
  private async recordLegacyRepairConflict(retryId: string, candidateAttemptId: string, conflictType: string, existingResultingId: string | null): Promise<void> {
    const action = `payment_retry_legacy_lineage_conflict_${conflictType}`;
    logger.error("failed_payment_retry_coordinator_legacy_lineage_conflict", { retryId, candidateAttemptId, conflictType, existingResultingId });
    const already = await this.db
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryId), eq(auditEvent.action, action)))
      .limit(1);
    if (already[0]) return;
    await this.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: { existingResultingId },
      newValue: { conflictType, candidateAttemptId },
      reason: `Legacy retry lineage repair refused: ${conflictType}. No mutation, no application, no provider call.`,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_retry",
      targetResourceId: retryId,
    });
  }

  /**
   * R11 PASS B1 — FINAL CORRECTION (Defect 1 + Defect 2 — MAKE REPAIR A REAL PRODUCTION PATH +
   * REMOVE FIXED-PREFIX STARVATION). Called directly from `ReconciliationService.repairBatch` — the
   * SAME production scheduler entry point `/api/scheduler/recover-payment-webhooks` already invokes
   * — never a separate, unused public method or an admin-only manual trigger.
   *
   * STARVATION FIX: the candidate query itself, at the database level, selects ONLY `fired` retries
   * where (a) the retry's own recorded original attempt is genuinely `partial-payment-<id>`-keyed
   * (conclusively unrelated rows are excluded before ever reaching application code), (b) that
   * proposal's own status is NOT ALREADY `"applied"` (a fully healthy, already-repaired row drops
   * out of every future scan the instant `applyIfAwaitingPayment` succeeds — see
   * `repairLegacyLineageAndApply`'s own atomic-write step), AND (c) no durable
   * `payment_retry_legacy_lineage_conflict_*` marker already exists for this retry (a nonrepairable
   * data contradiction is recorded once and then never monopolizes a future batch again). Ordered by
   * `(firedAt, id)` — a stable tie-breaker, never a plain `LIMIT` alone — and, because every one of
   * those three exclusions is itself durable and self-shrinking (never re-added once satisfied),
   * repeated bounded calls are guaranteed to eventually reach every genuinely unresolved candidate
   * with no process-memory cursor and no unbounded full-history scan — the exact same
   * self-shrinking-candidate-set discipline `repairBatch`'s own pre-existing
   * `listMissingClearingCandidates`/`listMissingReversalCandidates` already establish.
   *
   * Intentionally scoped to the direct one-hop case (`retry.originalPaymentAttemptId` is ITSELF the
   * `partial-payment-<id>`-keyed attempt) — this is the shape every legacy pre-Phase-A-fix backlog
   * row actually has; `repairLegacyLineageAndApply`'s own full, bounded multi-hop lineage walk (via
   * `PartialPaymentAutoApplicationService.resolveLineage`) still runs once a candidate IS selected,
   * so this scoping only affects which rows are proactively DISCOVERED by this scan, never the
   * correctness of repairing one once found.
   *
   * R11 PASS B1 — SURGICAL FINAL PATCH (Part 1A — ONLY SCAN ROWS THAT CAN ACTUALLY OWE PROPOSAL
   * APPLICATION): the deterministic `retry-<id>` replacement must ALSO both exist AND already carry
   * a durable `payment_cleared` ledger entry before this row is even selected. This fired-scan's own
   * job is repairing a MISSING PROPOSAL APPLICATION after money already cleared — a replacement that
   * FAILED and never cleared can never owe that application and must never consume this bounded
   * batch waiting on a clearing that will never happen; it simply never matches this WHERE clause,
   * rather than being selected and returned `deferred` forever.
   *
   * R11 PASS B1 — SURGICAL FINAL PATCH (Part 1C/1D — BACKOFF ELIGIBILITY + STABLE ORDER): also
   * requires `nextResolutionAttemptAt IS NULL OR <= now` — the SAME existing durable field the
   * claimed-resumption scheduler already uses for its own backoff (see
   * `repairLegacyLineageAndApply`'s own transient-failure catch block, which sets it). Ordered
   * `(nextResolutionAttemptAt ASC NULLS FIRST, firedAt ASC, id ASC)` — eligible-first, then oldest,
   * with a stable id tie-breaker — never an in-memory cursor, never a `LIMIT` increase as a
   * substitute for correctness.
   *
   * For each candidate, the replacement attempt is resolved via the SAME deterministic `retry-<id>`
   * idempotency key form the dispatch pipeline itself mints, then validated/repaired/applied through
   * the exact same `repairLegacyLineageAndApply` path the scheduler's own "already resolved" branches
   * use — never a second, independently-diverging repair implementation. Never replays webhook
   * financial effects, reposts clearing, calls the payment provider, or creates a new retry/charge —
   * `repairLegacyLineageAndApply`/`applyClearedPayment` are pure, idempotent, read-mostly operations
   * with no such side effects (Defect 8 — preserved unchanged from the prior round).
   */
  async repairLegacyRetryLineage(limit = 200, now: Date = new Date()): Promise<{ scanned: number }> {
    const originalAttempt = alias(paymentAttempt, "legacy_repair_original_attempt");
    const replacementAttempt = alias(paymentAttempt, "legacy_repair_replacement_attempt");
    const candidates = await this.db
      .select({ id: paymentRetry.id })
      .from(paymentRetry)
      .where(
        and(
          eq(paymentRetry.status, "fired"),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(originalAttempt)
              .innerJoin(partialPaymentRequest, sql`${originalAttempt.idempotencyKey} = 'partial-payment-' || ${partialPaymentRequest.id}::text`)
              .where(and(eq(originalAttempt.id, paymentRetry.originalPaymentAttemptId), ne(partialPaymentRequest.status, "applied"))),
          ),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(replacementAttempt)
              .where(
                and(
                  sql`${replacementAttempt.idempotencyKey} = 'retry-' || ${paymentRetry.id}::text`,
                  exists(
                    this.db
                      .select({ one: sql`1` })
                      .from(ledgerJournalEntry)
                      .where(and(eq(ledgerJournalEntry.paymentAttemptId, replacementAttempt.id), eq(ledgerJournalEntry.entryType, "payment_cleared"))),
                  ),
                ),
              ),
          ),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(auditEvent)
              .where(
                and(
                  eq(auditEvent.targetResourceType, "payment_retry"),
                  sql`${auditEvent.targetResourceId} = ${paymentRetry.id}::text`,
                  like(auditEvent.action, "payment_retry_legacy_lineage_conflict_%"),
                ),
              ),
          ),
          or(isNull(paymentRetry.nextResolutionAttemptAt), lte(paymentRetry.nextResolutionAttemptAt, now)),
        ),
      )
      .orderBy(sql`${paymentRetry.nextResolutionAttemptAt} ASC NULLS FIRST`, asc(paymentRetry.firedAt), asc(paymentRetry.id))
      .limit(limit);
    for (const { id: retryId } of candidates) {
      const attemptRows = await this.db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, `retry-${retryId}`)).limit(1);
      const attempt = attemptRows[0];
      if (!attempt) continue; // defensive only — the selector above already required this to exist.
      await this.repairLegacyLineageAndApply(retryId, attempt.id);
    }
    return { scanned: candidates.length };
  }

  async coordinateFailure(input: { installmentScheduleItemId: string; payment: PaymentAttemptRecord }): Promise<CoordinateFailureResult> {
    const result = await this.db.transaction(async (tx) => {
      // R11 PASS A — FINAL TARGETED CORRECTION (Defect 2 — coordinateFailure LOCK-ORDER INVERSION):
      // this method is the ONLY one in this class that INSERTs a NEW `payment_retry` row (below) —
      // `coordinateSuccess`/`coordinateSupersession`/`claimRetryForExecution` only ever UPDATE an
      // EXISTING `payment_retry` row's status, which never touches its `agreement_id` FK column and so
      // never triggers an implicit lock. That insert's own `agreementId` FK takes an implicit `FOR KEY
      // SHARE` lock on the referenced `agreement` row — so locking the installment FIRST (the
      // pre-existing order) and only reaching that insert LATER was `installment -> agreement`, exactly
      // backwards from the `agreement -> installment -> payment_attempt/ledger writes` order every
      // other Pass-A-fixed transaction now uses (`DrizzleInstallmentAwarePaymentReserver`,
      // `DrizzleAtomicManualPaymentPoster`, `establishDurableDispatchIntent`) — the same cross-wait
      // cycle risk against those paths. FIX: lock `agreement` FIRST, using `input.payment.agreementId`
      // (already available on the caller-supplied `PaymentAttemptRecord`, never requiring a NEW
      // caller-supplied parameter) — before the installment row is ever locked. The pre-existing
      // "payment with no agreementId" defensive check (structurally unreachable in practice — every
      // provider-routed payment has a non-null agreementId, enforced at
      // `PaymentService.submitToProvider`) necessarily moves here too, since there is nothing to lock
      // without it; every OTHER behavior (idempotency checks, the past_due write, retry creation) is
      // unchanged, just now reached after this additional, earlier lock.
      if (!input.payment.agreementId) {
        throw new ConfigurationError("Cannot schedule a retry for a payment with no agreementId.");
      }
      const agreementLockRows = await tx.select({ id: agreement.id }).from(agreement).where(eq(agreement.id, input.payment.agreementId)).for("update").limit(1);
      if (!agreementLockRows[0]) throw new ConfigurationError("agreement not found for payment.agreementId");
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();

      // Row lock held for the ENTIRE remainder of this transaction — a concurrent coordinateSuccess
      // for the SAME installment blocks here until this transaction commits or rolls back.
      const installmentRows = await tx
        .select({ status: installmentScheduleItem.status })
        .from(installmentScheduleItem)
        .where(eq(installmentScheduleItem.id, input.installmentScheduleItemId))
        .for("update")
        .limit(1);
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();

      // R11 PASS B1 — TARGETED FINAL CORRECTION (Defect B1-B — coordinateFailure SILENTLY MUTATES
      // paid/waived HISTORY): "paid" and "waived" are HISTORICAL dispositions — a FAILED attempt
      // never clears money, so it never reduces existing settlement, so a failure has NO basis to
      // reopen either one. Preserved UNCONDITIONALLY here, before any authoritative recompute even
      // runs: never demoted to scheduled/past_due merely because a currently-recomputed authoritative
      // total happens to look insufficient (that is a RECONCILIATION condition — see the read-only
      // historical-reconciliation sweep — never a charge trigger), and never used as the basis to
      // schedule a new retry. "waived" is especially strict: there is no waiver-revocation workflow
      // anywhere in ordinary success/failure/retry processing. Legitimate reopening after a REAL
      // reduction (a refund/reversal/dispute/supersession that actually reduces net settlement)
      // remains exclusively `coordinateSupersession`'s job — unaffected by this branch, since that
      // method never reaches this one.
      if (installmentRows[0]?.status === "paid" || installmentRows[0]?.status === "waived") {
        return { outcome: "already_settled" as const };
      }

      // R11 PASS B1 (Defect B1-4 — RETRY ELIGIBILITY STILL USES CACHED-PAID GATES): for an ordinary
      // scheduled/past_due installment, "already settled, no retry needed" is decided from
      // AUTHORITATIVE, tx-bound net contribution (`computeInstallmentSettlementWithinTx` — the SAME
      // arithmetic `coordinateSuccess`/`coordinateSupersession` already use), never a SECOND cached
      // status read. A stale cached "scheduled"/"past_due" that authoritative evidence disagrees with
      // (i.e., is actually already fully covered) must still skip scheduling a redundant retry — this
      // is the SAME kind of live, authoritative status correction `coordinateSuccess` already
      // performs for these two ordinary statuses, never the separate, read-only historical
      // reconciliation sweep's "report, don't rewrite" policy, which applies only to that sweep.
      const settlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);
      if (settlement?.isSatisfied) {
        return { outcome: "already_settled" as const };
      }

      // Safe to write unconditionally here — the row lock above already proved, inside THIS
      // transaction, that the cached status is one of "scheduled"/"past_due" (never "paid"/"waived",
      // guarded above), and the authoritative check just above proved it is not currently satisfied.
      await tx.update(installmentScheduleItem).set({ status: "past_due" }).where(eq(installmentScheduleItem.id, input.installmentScheduleItemId));

      // Same two idempotency checks PaymentRetryService.scheduleRetryForFailedPayment performs —
      // reusing the identical retry architecture, just inside this transaction/lock.
      const alreadyARetryResult = await tx
        .select({ id: paymentRetry.id })
        .from(paymentRetry)
        .where(eq(paymentRetry.resultingPaymentAttemptId, input.payment.id))
        .limit(1);
      if (alreadyARetryResult[0]) {
        return { outcome: "already_settled" as const }; // this payment IS a retry's own charge — never re-retry it.
      }

      const existing = await tx
        .select({ id: paymentRetry.id })
        .from(paymentRetry)
        .where(eq(paymentRetry.originalPaymentAttemptId, input.payment.id))
        .limit(1);
      if (existing[0]) {
        return { outcome: "retry_scheduled" as const, retryId: existing[0].id, alreadyExisted: true };
      }

      const scheduledFor = addBusinessDays(new Date(), this.delayBusinessDays);
      const [inserted] = await tx
        .insert(paymentRetry)
        .values({
          originalPaymentAttemptId: input.payment.id,
          installmentScheduleItemId: input.installmentScheduleItemId,
          agreementId: input.payment.agreementId,
          scheduledFor,
        })
        .returning();
      if (!inserted) throw new ConfigurationError("payment_retry insert returned no row");
      return { outcome: "retry_scheduled" as const, retryId: inserted.id, alreadyExisted: false };
    });

    if (result.outcome === "retry_scheduled" && !result.alreadyExisted) {
      await this.audit.record({
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: input.payment.payerProfileKind,
        profileId: input.payment.payerProfileId,
        agreementId: input.payment.agreementId,
        action: "payment_retry_scheduled",
        occurredAt: new Date().toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: null,
        reason: null,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payment_retry",
        targetResourceId: result.retryId,
      });
    }
    return result;
  }

  async coordinateSuccess(input: { installmentScheduleItemId: string }): Promise<{ canceledRetryIds: string[]; installmentSatisfied: boolean }> {
    const { canceledRetryIds, installmentSatisfied } = await this.db.transaction(async (tx) => {
      // Same row lock, same key as coordinateFailure — see this class's own doc comment.
      const lockRows = await tx
        .select({ status: installmentScheduleItem.status, dueDate: installmentScheduleItem.dueDate })
        .from(installmentScheduleItem)
        .where(eq(installmentScheduleItem.id, input.installmentScheduleItemId))
        .for("update")
        .limit(1);
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();
      if (!lockRows[0]) return { canceledRetryIds: [] as string[], installmentSatisfied: false };

      // R11 (INSTALLMENT AMOUNT-AWARENESS): authoritative, fresh-under-lock net contribution — see
      // this class's own interface doc comment on `coordinateSuccess` for why a partial success must
      // never mark "paid" or cancel a still-legitimate pending retry for the remainder.
      const settlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);
      if (!settlement) return { canceledRetryIds: [] as string[], installmentSatisfied: false };

      if (!settlement.isSatisfied) {
        // Not yet fully covered — reflect due-date-based scheduled/past_due, exactly like
        // coordinateFailure's own rule, unless the installment was explicitly waived (never
        // overwritten by an amount-aware recompute). Naturally idempotent — see this class's own
        // interface doc comment for why no durable marker is required here.
        if (lockRows[0].status !== "waived") {
          const newStatus = isPastDate(lockRows[0].dueDate) ? ("past_due" as const) : ("scheduled" as const);
          if (lockRows[0].status !== newStatus) {
            await tx.update(installmentScheduleItem).set({ status: newStatus }).where(eq(installmentScheduleItem.id, input.installmentScheduleItemId));
          }
        }
        return { canceledRetryIds: [] as string[], installmentSatisfied: false };
      }

      if (lockRows[0].status !== "paid") {
        await tx.update(installmentScheduleItem).set({ status: "paid" }).where(eq(installmentScheduleItem.id, input.installmentScheduleItemId));
      }

      // R09 corrective pass (Codex blocker 3A): ALL executable retries for this installment, in ONE
      // bounded, set-based UPDATE — never "select one, update one". Multiple failed attempts for the
      // SAME installment can each have their own retry (uniqueness is per ORIGINAL payment attempt,
      // not per installment), so after this, zero NEWLY-cancelable retries for this installment remain.
      //
      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 3 — B3 fix; Stage 9 remediation,
      // Root Correction 1 — DURABLE DISPATCH INTENT MUST EXIST BEFORE PROVIDER CALL): a "claimed"
      // retry is excluded from this UPDATE when ANY `payment_attempt` row already exists for it
      // (keyed by the fixed `retry-${id}` idempotency convention every call site uses) — proof an
      // external dispatch was actually attempted and may have succeeded, which must remain
      // discoverable via `findClaimedForResumption` regardless of this installment's own settlement.
      // Deliberately NOT narrowed to `status = 'submitted'` (the pre-Stage-9 check): under the current
      // two-phase dispatch protocol, the anchor's own status legitimately transitions
      // `submitted -> processing` (a non-terminal provider response) BEFORE the retry itself is ever
      // marked `fired` — a `coordinateSuccess` sweep landing in exactly that window must still treat
      // the anchor's mere EXISTENCE as proof of a real dispatch attempt, never re-derive "was this
      // dispatched" from one specific interim status value. Safe to widen unconditionally: a retry
      // whose OWN dispatch attempt was instead a DEFINITE rejection always has its `payment_retry` row
      // marked `canceled` in the SAME transaction that marks its `payment_attempt` row `failed` (see
      // `dispatchProviderCallForAnchor`/`resolveNotFoundOutcome`'s own doc comments) — such a retry is
      // never still `claimed` for this UPDATE's own `CANCELABLE_RETRY_STATUSES` filter to even reach.
      // See `CANCELABLE_RETRY_STATUSES`'s own doc comment for the two structurally different "claimed"
      // sub-states this distinguishes.
      const canceled = await tx
        .update(paymentRetry)
        .set({ status: "canceled", canceledAt: new Date(), canceledReason: "A payment for this installment succeeded." })
        .where(
          and(
            eq(paymentRetry.installmentScheduleItemId, input.installmentScheduleItemId),
            inArray(paymentRetry.status, CANCELABLE_RETRY_STATUSES),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(paymentAttempt)
                .where(sql`${paymentAttempt.idempotencyKey} = 'retry-' || ${paymentRetry.id}::text`),
            ),
          ),
        )
        .returning({ id: paymentRetry.id });
      return { canceledRetryIds: canceled.map((row) => row.id), installmentSatisfied: true };
    });

    for (const canceledRetryId of canceledRetryIds) {
      await this.audit.record({
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: null,
        profileId: null,
        agreementId: null,
        action: "payment_retry_canceled",
        occurredAt: new Date().toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: null,
        reason: "A payment for this installment succeeded.",
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payment_retry",
        targetResourceId: canceledRetryId,
      });
    }
    return { canceledRetryIds, installmentSatisfied };
  }

  async coordinateSupersession(input: {
    installmentScheduleItemId: string;
    payment: PaymentAttemptRecord;
    providerEventId: string;
  }): Promise<CoordinateSupersessionResult> {
    // OPTIMIZATION ONLY — never the correctness gate (Codex final concurrency re-review). Skips
    // opening a transaction/acquiring the installment lock at all for the common retry case (this
    // event's disposition already durably determined, either way) — but this read is NOT
    // lock-guarded and can be stale the instant it returns. The AUTHORITATIVE re-check happens again
    // unconditionally, inside the transaction below, and — critically — only AFTER the installment
    // row lock is acquired (never before it): that lock is this method's actual mutual-exclusion
    // boundary, not this pre-check.
    const precheck = await this.db
      .select({ action: auditEvent.action, newValue: auditEvent.newValue })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.providerEventId, input.providerEventId),
          inArray(auditEvent.action, [INSTALLMENT_REOPENED_ACTION, INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION]),
        ),
      )
      .limit(1);
    if (precheck[0]?.action === INSTALLMENT_REOPENED_ACTION) return { outcome: "already_compensated" as const };
    if (precheck[0]?.action === INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION) return { outcome: notRequiredDispositionOutcome(precheck[0].newValue) };

    return this.db.transaction(async (tx) => {
      if (this.hooks?.beforeInstallmentLock) await this.hooks.beforeInstallmentLock();

      // Same row lock, same key as coordinateFailure/coordinateSuccess — see this class's own doc
      // comment. MUST be acquired BEFORE the authoritative disposition check, never after (Codex
      // final concurrency re-review): the installment row lock is this method's ONLY serialization
      // boundary — two overlapping workers processing the SAME superseding event both reach this
      // `for("update")` call, but only ONE is ever granted the lock first; the other genuinely BLOCKS
      // here until the first commits or rolls back, then re-acquires the lock and re-reads
      // authoritative, post-commit state. Checking dispositions BEFORE this lock (the prior version's
      // defect) let two overlapping workers both observe "no disposition yet" and then both proceed
      // to decide — the lock had already been bypassed by the time either worker's decision was made.
      const rows = await tx
        .select({ status: installmentScheduleItem.status, dueDate: installmentScheduleItem.dueDate })
        .from(installmentScheduleItem)
        .where(eq(installmentScheduleItem.id, input.installmentScheduleItemId))
        .for("update")
        .limit(1);
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();

      // AUTHORITATIVE disposition check — now genuinely POST-LOCK: any other worker that already
      // durably recorded either disposition for THIS providerEventId did so only after ALSO holding
      // this exact row lock (this method's only two writers are the two branches below, both reached
      // only from here), so if a competing worker committed first, this query — running only after
      // this worker was granted the lock, which can only happen after that commit released it — is
      // guaranteed to observe it. Never `installment.status` alone (see this method's own doc comment
      // for exactly why that is unsafe once a later, unrelated, legitimate payment can change it).
      const existing = await tx
        .select({ action: auditEvent.action, newValue: auditEvent.newValue })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.providerEventId, input.providerEventId),
            inArray(auditEvent.action, [INSTALLMENT_REOPENED_ACTION, INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION]),
          ),
        )
        .limit(1);
      if (existing[0]?.action === INSTALLMENT_REOPENED_ACTION) return { outcome: "already_compensated" as const };
      if (existing[0]?.action === INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION) return { outcome: notRequiredDispositionOutcome(existing[0].newValue) };

      const secret = getServerEnv().AUDIT_HASH_SECRET;

      // R11 PASS B1 — FINAL TARGETED CORRECTION (Defect 2 — WAIVED INSTALLMENT REOPENED BY
      // coordinateSupersession): checked here, under the SAME installment row lock, BEFORE any
      // authoritative settlement recompute — "waived" is preserved unconditionally, exactly like
      // coordinateFailure's own identical "paid"/"waived" guard, never re-derived from whether the
      // reversed payment's own money left the installment authoritatively short. Recorded via the
      // SAME durable "not required" marker architecture the "not_paid"/"still_satisfied" dispositions
      // already use (one exact-once mechanism, reused, never duplicated) — a later retry of this
      // exact event finds this marker first and never re-examines live installment evidence again.
      if (rows[0]?.status === "waived") {
        const payload: AuditEventPayload = {
          actorUserId: null,
          actorRole: "payment_provider",
          profileKind: input.payment.payerProfileKind,
          profileId: input.payment.payerProfileId,
          agreementId: input.payment.agreementId,
          action: INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION,
          occurredAt: new Date().toISOString(),
          ipAddress: null,
          deviceInfo: null,
          previousValue: { installmentStatus: "waived" },
          newValue: { disposition: "waived_preserved", supersedingPaymentStatus: input.payment.status },
          reason: `Payment ${input.payment.status}, but the installment was explicitly waived — a waiver is never revoked by ordinary supersession processing.`,
          authStrength: null,
          relatedDocumentId: null,
          relatedCaseId: null,
          targetResourceType: "installment_schedule_item",
          targetResourceId: input.installmentScheduleItemId,
          providerEventId: input.providerEventId,
        };
        await appendAuditEventTxBound(tx, payload, (previousEventHash) => computeAuditEventHash(payload, previousEventHash, secret));
        return { outcome: "waived_preserved" as const };
      }

      // R11 (INSTALLMENT AMOUNT-AWARENESS — ARCHITECT-APPROVED DESIGN): authoritative, fresh-under-
      // lock net contribution AFTER this reversal's own ledger effect (already posted before this
      // method is ever called — see `PaymentWebhookService`'s dispatch ordering) — NEVER
      // `installment.status` alone. See this method's own interface doc comment for exactly why a
      // naive status-only check can incorrectly reopen an installment that remains fully covered by
      // another, still-valid contribution.
      const settlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);

      if (!settlement || settlement.isSatisfied) {
        // Either the installment row is genuinely gone (defensive only — never expected in practice)
        // or it remains fully amount-satisfied despite this reversal (another contribution's own
        // money still covers it in full) — no reopen required either way. Recorded atomically via the
        // SAME tx-bound append this class's other marker uses (see `appendAuditEventTxBound`'s own
        // doc comment — one implementation, reused, never duplicated). A FUTURE retry of this exact
        // event will find THIS marker first and never re-evaluate installment evidence again,
        // regardless of what legitimately changes it later.
        const disposition = settlement ? "still_satisfied" : "not_paid";
        const payload: AuditEventPayload = {
          actorUserId: null,
          actorRole: "payment_provider",
          profileKind: input.payment.payerProfileKind,
          profileId: input.payment.payerProfileId,
          agreementId: input.payment.agreementId,
          action: INSTALLMENT_REOPEN_NOT_REQUIRED_ACTION,
          occurredAt: new Date().toISOString(),
          ipAddress: null,
          deviceInfo: null,
          previousValue: { installmentStatus: rows[0]?.status ?? null, settledMinorUnits: settlement?.settledMinorUnits ?? null },
          newValue: { disposition, supersedingPaymentStatus: input.payment.status },
          reason:
            disposition === "still_satisfied"
              ? `Payment ${input.payment.status}, but the installment remains fully amount-satisfied by other contributions — no reopen required.`
              : `Payment ${input.payment.status}, but its installment was not currently amount-satisfied — no reopen required.`,
          authStrength: null,
          relatedDocumentId: null,
          relatedCaseId: null,
          targetResourceType: "installment_schedule_item",
          targetResourceId: input.installmentScheduleItemId,
          providerEventId: input.providerEventId,
        };
        await appendAuditEventTxBound(tx, payload, (previousEventHash) => computeAuditEventHash(payload, previousEventHash, secret));
        return { outcome: disposition === "still_satisfied" ? ("still_satisfied" as const) : ("not_paid" as const) };
      }

      const newStatus = isPastDate(settlement.dueDate) ? ("past_due" as const) : ("scheduled" as const);
      await tx.update(installmentScheduleItem).set({ status: newStatus }).where(eq(installmentScheduleItem.id, input.installmentScheduleItemId));

      // ATOMIC durable completion marker — inserted in THIS SAME transaction, never as a separate
      // step afterward (that gap is exactly the Case B crash window this correction closes). Cannot
      // call through `AuditService`/`appendAtomically` here — that method opens its OWN
      // `db.transaction` against the same shared, `max: 1`-pooled `getDb()` singleton, which deadlocks
      // from inside an already-open transaction on it (the same class of problem
      // `computeRemainingBalanceMinorUnitsWithinTx`, above, already documents and avoids the same way).
      // Uses `appendAuditEventTxBound` — the SAME extracted sequence `appendAtomically` itself now
      // delegates to (see that function's own doc comment) — never a second, independently-diverging
      // audit-chain implementation.
      const payload: AuditEventPayload = {
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: input.payment.payerProfileKind,
        profileId: input.payment.payerProfileId,
        agreementId: input.payment.agreementId,
        action: INSTALLMENT_REOPENED_ACTION,
        occurredAt: new Date().toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: { installmentStatus: "paid" },
        newValue: { installmentStatus: newStatus, supersedingPaymentStatus: input.payment.status },
        reason: `A previously succeeded payment for this installment was later ${input.payment.status}.`,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "installment_schedule_item",
        targetResourceId: input.installmentScheduleItemId,
        providerEventId: input.providerEventId,
      };
      await appendAuditEventTxBound(tx, payload, (previousEventHash) => computeAuditEventHash(payload, previousEventHash, secret));

      return { outcome: "reopened" as const, newStatus };
    });
  }

  async claimRetryForExecution(input: { installmentScheduleItemId: string; retryId: string }): Promise<ClaimForExecutionResult> {
    return this.db.transaction(async (tx) => {
      // Same row lock, same key as coordinateFailure/coordinateSuccess — see this class's own doc comment.
      const installmentRows = await tx
        .select({ status: installmentScheduleItem.status })
        .from(installmentScheduleItem)
        .where(eq(installmentScheduleItem.id, input.installmentScheduleItemId))
        .for("update")
        .limit(1);
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();
      // R11 PASS B1 (Defect B1-4): authoritative amount-aware satisfaction, never cached status alone
      // — see `coordinateFailure`'s own identical correction for exactly why.
      const settlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);
      if (settlement?.isSatisfied) return { outcome: "not_claimable" };
      void installmentRows;

      const executionToken = randomUUID();
      const [claimed] = await tx
        .update(paymentRetry)
        .set({ status: "claimed", executionToken })
        .where(and(eq(paymentRetry.id, input.retryId), eq(paymentRetry.status, "scheduled")))
        .returning({ id: paymentRetry.id });
      if (!claimed) return { outcome: "not_claimable" };
      return { outcome: "claimed", executionToken };
    });
  }

  async claimAndExecuteRetry(input: {
    installmentScheduleItemId: string;
    retryId: string;
    idempotencyKey: string;
    agreementId: string;
    provider: PaymentProvider;
    prepared: PreparedRetrySubmission;
    payer: ProfileRef;
    recipient: ProfileRef;
    effectApplier: ProviderOutcomeEffectApplier;
  }): Promise<ExecuteRetryResult> {
    const intent = await this.establishDurableDispatchIntent({
      installmentScheduleItemId: input.installmentScheduleItemId,
      retryId: input.retryId,
      idempotencyKey: input.idempotencyKey,
      agreementId: input.agreementId,
      providerName: input.provider.providerName,
      prepared: input.prepared,
      payer: input.payer,
      recipient: input.recipient,
    });
    if (intent.outcome === "not_claimable") return { outcome: "not_claimable" };
    // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1): Phase A has ALREADY durably
    // committed by this point — a failure anywhere below (including this whole call throwing) can
    // never erase the claim or the discovery anchor; see `establishDurableDispatchIntent`'s own doc
    // comment.
    return this.dispatchProviderCallForAnchor({
      installmentScheduleItemId: input.installmentScheduleItemId,
      retryId: input.retryId,
      paymentAttemptId: intent.paymentAttemptId,
      agreementId: input.agreementId,
      provider: input.provider,
      effectApplier: input.effectApplier,
    });
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1 — DURABLE DISPATCH INTENT MUST
   * EXIST BEFORE PROVIDER CALL). PHASE A: a SHORT, INDEPENDENTLY COMMITTED transaction — claims the
   * retry and inserts the `payment_attempt` discovery anchor (`status = "submitted"`, keyed by the
   * stable `idempotencyKey`), and NOTHING else — no provider call happens anywhere in this method.
   * Reuses the EXISTING `payment_attempt` status model: `"submitted"` already truthfully means
   * "provider dispatch may or may not have occurred; outcome must be resolved before another
   * logically-new payment is allowed" (see `PaymentService.submitToProvider`'s own identical use of
   * this same status immediately before its own provider call) — no new schema/status was needed,
   * only committing this row BEFORE the provider is ever called, in its own transaction, rather than
   * inside the same one as the dispatch attempt.
   *
   * Idempotent re-entry: if a `payment_attempt` row already exists for this `idempotencyKey` (an
   * earlier Phase A attempt whose Phase B never got a chance to run, a resumption, or — defensively —
   * any other re-entry), it is adopted (`already_dispatched`), never duplicated.
   */
  private async establishDurableDispatchIntent(input: {
    installmentScheduleItemId: string;
    retryId: string;
    idempotencyKey: string;
    agreementId: string;
    providerName: string;
    prepared: PreparedRetrySubmission;
    payer: ProfileRef;
    recipient: ProfileRef;
  }): Promise<{ outcome: "not_claimable" } | { outcome: "ready" | "already_dispatched"; paymentAttemptId: string }> {
    return this.db.transaction(async (tx) => {
      // R11 CORRECTION PASS A (Defect A3 — AGREEMENT/INSTALLMENT DEADLOCK CYCLE): agreement row lock
      // FIRST — before the installment row — matching the SAME `agreement -> installment ->
      // payment_attempt/ledger writes` order every other transaction that needs both locks now uses
      // (see `DrizzleInstallmentAwarePaymentReserver`'s own top-level doc comment for the exact cycle
      // this closes: this method's own `payment_attempt` INSERT below takes an implicit FOR KEY SHARE
      // lock on `agreement` for its FK check, which — with only the installment locked first — was
      // exactly backwards from `DrizzleAtomicManualPaymentPoster`'s `agreement -> installment` order).
      const agreementLockRows = await tx.select({ id: agreement.id }).from(agreement).where(eq(agreement.id, input.agreementId)).for("update").limit(1);
      if (!agreementLockRows[0]) return { outcome: "not_claimable" };
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();

      // Same installment-row lock key `coordinateFailure`/`coordinateSuccess` use — held only for
      // this SHORT transaction's own duration (never across the provider call — that happens, if at
      // all, in the SEPARATE Phase B transaction below).
      const installmentRows = await tx
        .select({ status: installmentScheduleItem.status })
        .from(installmentScheduleItem)
        .where(eq(installmentScheduleItem.id, input.installmentScheduleItemId))
        .for("update")
        .limit(1);
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();
      // R11 PASS B1 (Defect B1-4): authoritative amount-aware satisfaction, never cached status alone
      // — see `coordinateFailure`'s own identical correction for exactly why.
      const preInsertSettlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);
      if (preInsertSettlement?.isSatisfied) return { outcome: "not_claimable" };
      void installmentRows;

      // R11 CORRECTION PASS A (Defect A2): the target installment must genuinely belong to THIS
      // retry's own agreement — see `assertInstallmentBelongsToAgreementWithinTx`'s own doc comment.
      // Mapped to "not_claimable" (never a raw throw) — this is a pre-dispatch structural refusal,
      // handled by `fireDueRetries`'s retry loop exactly like any other "not currently executable"
      // reason; a retry's own `installmentScheduleItemId`/`agreementId` are always the SAME values
      // the original failed payment was created (and already ownership-validated) with, so this is
      // defense-in-depth for this path, never expected to actually reject in practice.
      try {
        await assertInstallmentBelongsToAgreementWithinTx(tx, input.installmentScheduleItemId, input.agreementId);
      } catch {
        return { outcome: "not_claimable" };
      }

      // Idempotency key looked up FIRST, inside the lock, before any insert — see this method's own
      // doc comment.
      const existingRows = await tx.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, input.idempotencyKey)).limit(1);
      const existing = existingRows[0];
      if (existing) return { outcome: "already_dispatched", paymentAttemptId: existing.id };

      // R11 TARGETED PROVIDER-RESERVATION CORRECTION: "at most one unresolved payment attempt per
      // installment" — a retry's own resulting attempt is a NEW charge attempt against this
      // installment, exactly like any other provider-routed reservation, so it must be blocked the
      // same way if a DIFFERENT, still-unresolved attempt already reserves this installment (e.g. a
      // concurrent ordinary payment). The ORIGINAL failed payment that scheduled this retry is
      // explicitly excluded BY IDENTITY (`payment_retry.original_payment_attempt_id`), never merely by
      // its current status — see `assertNoCompetingUnresolvedInstallmentAttemptWithinTx`'s own doc
      // comment for why this, not "just check it's terminal," is the correct exclusion for a retry's
      // own originating payment specifically. Mapped to "not_claimable" (never a raw throw) — the SAME
      // established outcome this method's other pre-dispatch refusals already use, so every existing
      // caller (fireDueRetries's own retry loop) handles it exactly like any other "not currently
      // executable" reason, with no new error-handling path required.
      const originalPaymentRows = await tx.select({ originalPaymentAttemptId: paymentRetry.originalPaymentAttemptId }).from(paymentRetry).where(eq(paymentRetry.id, input.retryId)).limit(1);
      try {
        await assertNoCompetingUnresolvedInstallmentAttemptWithinTx(
          tx,
          input.installmentScheduleItemId,
          input.idempotencyKey,
          originalPaymentRows[0]?.originalPaymentAttemptId,
        );
      } catch {
        return { outcome: "not_claimable" };
      }

      // Claim ONLY from "scheduled" — a genuinely new attempt. See this class's own interface doc
      // comment for why resuming a "claimed"/ambiguous retry is a wholly separate operation.
      const executionToken = randomUUID();
      const [claimed] = await tx
        .update(paymentRetry)
        .set({ status: "claimed", executionToken })
        .where(and(eq(paymentRetry.id, input.retryId), eq(paymentRetry.status, "scheduled")))
        .returning({ id: paymentRetry.id });
      if (!claimed) return { outcome: "not_claimable" };

      const [inserted] = await tx
        .insert(paymentAttempt)
        .values({
          idempotencyKey: input.idempotencyKey,
          payerProfileKind: input.payer.profileKind,
          payerProfileId: input.payer.profileId,
          recipientProfileKind: input.recipient.profileKind,
          recipientProfileId: input.recipient.profileId,
          amountMinorUnits: input.prepared.amountMinorUnits,
          currency: input.prepared.currency,
          agreementId: input.agreementId,
          providerName: input.providerName,
          installmentScheduleItemId: input.installmentScheduleItemId,
          paymentMethod: input.prepared.paymentMethod,
          bankConnectionId: input.prepared.bankConnectionId,
          status: "submitted",
        })
        .returning();
      if (!inserted) throw new ConfigurationError("payment_attempt insert returned no row");

      // R11 PASS B1 — ASYNC CORRELATION CORRECTION (Defect 1 — REPLACEMENT SUCCESS BEFORE DURABLE
      // LINEAGE): the durable retry/replacement lineage link (`payment_retry.resultingPaymentAttemptId`)
      // is committed HERE, atomically WITH this anchor's own creation — the earliest safe point its
      // identity is known — never deferred until Phase B's own later terminal-outcome resolution
      // (`applyFoundOutcome`/`markRetryFiredIfClaimed`, which still also (re)write it, harmlessly
      // idempotent, alongside the `status: "fired"` transition those own). This anchor's own
      // `providerPaymentId` cannot exist before Phase B's OWN, strictly LATER, separate transaction
      // calls the provider — so by the time ANY webhook (a real one, keyed by `providerPaymentId`, or
      // this coordinator's own internal `receiveInternalEvent`) could possibly reference this anchor
      // at all, this transaction has already committed and this lineage is already fully durable.
      // Closes the window where `PartialPaymentAutoApplicationService`'s own lineage lookup
      // (`findByResultingPaymentAttemptId`) could observe this column still null and incorrectly
      // conclude "not correlated to any proposal" — see that class's own doc comment.
      await tx.update(paymentRetry).set({ resultingPaymentAttemptId: inserted.id }).where(eq(paymentRetry.id, input.retryId));

      return { outcome: "ready", paymentAttemptId: inserted.id };
    });
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Corrections 1 & 2). PHASE B: a SEPARATE
   * transaction that only ever runs after Phase A's anchor is already durably committed. Re-acquires
   * the installment lock (held for this transaction's ENTIRE remainder, including across the provider
   * call — see this class's own top-level doc comment for why that is the correctness requirement and
   * a deliberate, narrow exception to the general rule), revalidates (not settled, overpayment), and
   * dispatches using the anchor's OWN already-persisted fields (never re-trusting the caller's
   * `prepared`/`payer`/`recipient` a second time — the anchor itself is now the single source of truth
   * for what this exact dispatch attempt is). A TERMINAL provider result is NEVER written directly
   * (Root Correction 2) — only `providerPaymentId` correlation is persisted here; the actual outcome
   * is resolved, AFTER this transaction commits, via the SAME `resolveSubmittedAnchor` pipeline
   * `resolveAmbiguousRetry` uses (a fresh, authenticated `retrievePaymentByIdempotencyKey` call, never
   * merely trusting `createPayment`'s own synchronous response shape).
   */
  private async dispatchProviderCallForAnchor(input: {
    installmentScheduleItemId: string;
    retryId: string;
    paymentAttemptId: string;
    agreementId: string;
    provider: PaymentProvider;
    effectApplier: ProviderOutcomeEffectApplier;
  }): Promise<ExecuteRetryResult> {
    type DispatchOutcome =
      | { kind: "not_claimable" }
      | { kind: "failed"; reason: string }
      | { kind: "ambiguous" }
      | { kind: "already_resolved"; anchor: typeof paymentAttempt.$inferSelect }
      | { kind: "dispatched"; anchor: typeof paymentAttempt.$inferSelect };

    const dispatchOutcome: DispatchOutcome = await this.db.transaction(async (tx) => {
      const installmentRows = await tx
        .select({ status: installmentScheduleItem.status })
        .from(installmentScheduleItem)
        .where(eq(installmentScheduleItem.id, input.installmentScheduleItemId))
        .for("update")
        .limit(1);
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();

      const anchorRows = await tx.select().from(paymentAttempt).where(eq(paymentAttempt.id, input.paymentAttemptId)).limit(1);
      const anchor = anchorRows[0];
      if (!anchor) throw new ConfigurationError("dispatchProviderCallForAnchor: anchor payment_attempt row not found");

      if (anchor.status !== "submitted") {
        // Already resolved by an earlier Phase B attempt (a redundant re-entry, e.g. a crash between
        // Phase B's own commit and this call returning) — adopt idempotently, never re-dispatch.
        return { kind: "already_resolved", anchor };
      }

      // R11 PASS B1 (Defect B1-4): authoritative amount-aware satisfaction, never cached status alone
      // — see `coordinateFailure`'s own identical correction for exactly why.
      const preDispatchSettlement = await computeInstallmentSettlementWithinTx(tx, input.installmentScheduleItemId);
      void installmentRows;
      if (preDispatchSettlement?.isSatisfied) {
        // Genuinely never dispatched (this transaction never reached the provider call below), and
        // settlement already happened via another payment — a DEFINITE pre-dispatch failure: safe to
        // close the local intent without ever calling the provider.
        await tx
          .update(paymentAttempt)
          .set({ status: "failed", failureReason: "The installment was already settled by another payment before this retry's own dispatch." })
          .where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: "The installment was already settled by another payment before dispatch." })
          .where(eq(paymentRetry.id, input.retryId));
        return { kind: "not_claimable" };
      }

      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1): the overpayment control
      // MUST be re-validated here, immediately before dispatch, while the installment lock is held —
      // see `computeRemainingBalanceMinorUnitsWithinTx`'s own doc comment for why (never the
      // externally-injected eligibility service, which would deadlock the shared `getDb()` singleton).
      const remainingBalance = await computeRemainingBalanceMinorUnitsWithinTx(tx, input.agreementId);
      if (remainingBalance !== null && anchor.amountMinorUnits > remainingBalance) {
        const reason = `This payment of ${anchor.amountMinorUnits} minor units would exceed the agreement's remaining balance of ${remainingBalance} minor units. Overpayment is not permitted.`;
        await tx.update(paymentAttempt).set({ status: "failed", failureReason: reason }).where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: `Firing failed: ${reason}` })
          .where(eq(paymentRetry.id, input.retryId));
        return { kind: "failed", reason };
      }
      // R11 (INSTALLMENT AMOUNT-AWARENESS — PAYMENT INITIATION CEILING): a retry is a NEW charge
      // attempt against this specific installment — re-validated here, under the SAME installment
      // lock, immediately before dispatch, exactly like the agreement-level check just above (never
      // trusting a stale ceiling check performed before this installment lock was acquired).
      try {
        await assertWithinInstallmentCeilingWithinTx(tx, input.installmentScheduleItemId, anchor.amountMinorUnits);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "installment_ceiling_exceeded";
        await tx.update(paymentAttempt).set({ status: "failed", failureReason: reason }).where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: `Firing failed: ${reason}` })
          .where(eq(paymentRetry.id, input.retryId));
        return { kind: "failed", reason };
      }

      // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Corrections 1 & 2): the try/catch is
      // DELIBERATELY scoped to ONLY the `provider.createPayment` call itself — never the persistence
      // step that follows a SUCCESSFUL response. `AmbiguousProviderResponseError` (request may or may
      // not have reached the provider) and any OTHER thrown error (a DEFINITE rejection — the provider
      // call itself never started or was explicitly refused) are the only two outcomes this catch
      // block may ever classify. A failure AFTER a successful `createPayment()` return (persisting
      // correlation/non-terminal status below) is a POST-DISPATCH / OUTCOME-UNKNOWN failure — the
      // provider call itself definitely happened — and is NEVER caught here, NEVER classified as a
      // definite rejection: it propagates out of this transaction (which rolls back, leaving Phase A's
      // own already-committed anchor untouched and still durably discoverable) rather than being
      // silently reclassified as "the retry failed to prepare."
      let providerResult;
      try {
        if (this.hooks?.beforeProviderCall) await this.hooks.beforeProviderCall();
        providerResult = await input.provider.createPayment({
          idempotencyKey: anchor.idempotencyKey,
          amountMinorUnits: anchor.amountMinorUnits,
          currency: anchor.currency,
          payer: { profileKind: anchor.payerProfileKind, profileId: anchor.payerProfileId },
          recipient: { profileKind: anchor.recipientProfileKind, profileId: anchor.recipientProfileId },
        });
      } catch (error) {
        if (error instanceof AmbiguousProviderResponseError) {
          // The anchor is left exactly as it is ("submitted") — this transaction still COMMITS
          // (never rolled back) so the anchor's own `idempotencyKey` durably guards every future
          // resumption against a duplicate submission. The retry itself stays `claimed`.
          return { kind: "ambiguous" };
        }
        const reason = error instanceof Error ? error.message : "unknown_processor_error";
        await tx.update(paymentAttempt).set({ status: "failed", failureReason: reason }).where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: `Firing failed: ${reason}` })
          .where(eq(paymentRetry.id, input.retryId));
        return { kind: "failed", reason };
      }

      // PAID2YOU — PACKAGE B (Root Correction 2): the provider call itself definitely succeeded — a
      // NON-terminal ("pending") response may advance the anchor conditionally; a TERMINAL response
      // (succeeded/failed) NEVER writes terminal status here — only correlation is persisted, and the
      // row stays "submitted" until resolved via the authoritative post-commit lookup below. If EITHER
      // update below throws, it propagates uncaught (see this method's own doc comment just above the
      // try/catch for why that is correct here).
      if (this.hooks?.afterProviderCallBeforePersist) await this.hooks.afterProviderCallBeforePersist();
      if (providerResult.status === "pending") {
        await tx.update(paymentAttempt).set({ status: "processing", providerPaymentId: providerResult.providerPaymentId }).where(eq(paymentAttempt.id, anchor.id));
      } else {
        await tx.update(paymentAttempt).set({ providerPaymentId: providerResult.providerPaymentId }).where(eq(paymentAttempt.id, anchor.id));
      }
      return { kind: "dispatched", anchor };
    });

    switch (dispatchOutcome.kind) {
      case "not_claimable":
        return { outcome: "not_claimable" };
      case "failed":
        return { outcome: "failed", reason: dispatchOutcome.reason };
      case "ambiguous":
        return { outcome: "ambiguous", paymentAttemptId: input.paymentAttemptId };
      case "already_resolved": {
        if (dispatchOutcome.anchor.status === "failed") {
          return { outcome: "failed", reason: "resulting_payment_attempt_failed" };
        }
        const repairDisposition = await this.repairLegacyLineageAndApply(input.retryId, dispatchOutcome.anchor.id);
        // R11 PASS B1 — SURGICAL FINAL PATCH (Part 2 — DEFERRED MUST NOT RETURN FIRED): a `"deferred"`
        // disposition must report the existing nonterminal outcome (`"ambiguous"`) — never `"fired"` —
        // so `PaymentRetryService.fireDueRetries` never counts this retry as resolved/fired while the
        // required effect is still genuinely incomplete; the retry stays `claimed`, remaining
        // discoverable via `findClaimedForResumption` on a later run.
        if (repairDisposition.kind === "deferred") {
          return { outcome: "ambiguous", paymentAttemptId: dispatchOutcome.anchor.id };
        }
        await this.markRetryFiredIfClaimed(input.retryId);
        return { outcome: "fired", resultingPaymentAttemptId: dispatchOutcome.anchor.id };
      }
      case "dispatched": {
        // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 2): deterministic proof point for
        // "a process crash between persisting the provider result and applying its required effects" —
        // see `afterDispatchCommitBeforeResolution`'s own doc comment. A throw here leaves the anchor
        // exactly as Phase B already committed it; the caller (e.g. `fireDueRetries`'s own resumption
        // loop, or a direct `resolveAmbiguousRetry` call) remains responsible for discovering and
        // completing it later — never lost.
        if (this.hooks?.afterDispatchCommitBeforeResolution) await this.hooks.afterDispatchCommitBeforeResolution();
        // PAID2YOU — PACKAGE B (Root Correction 2): obtain the AUTHORITATIVE outcome fresh, via the
        // SAME pipeline `resolveAmbiguousRetry` uses — never the synchronous `createPayment` response
        // above, which is never treated as equivalent to authenticated provider evidence.
        const retryRows = await this.db.select({ executionToken: paymentRetry.executionToken }).from(paymentRetry).where(eq(paymentRetry.id, input.retryId)).limit(1);
        const resolution = await this.resolveSubmittedAnchor(dispatchOutcome.anchor, input.retryId, retryRows[0]?.executionToken ?? null, input.provider, input.effectApplier);
        if (resolution.outcome === "fired") return { outcome: "fired", resultingPaymentAttemptId: resolution.resultingPaymentAttemptId };
        // A fresh lookup immediately after a successful dispatch coming back inconclusive/not-found is
        // the same shape as an ambiguous provider response — never re-dispatched a second time here.
        return { outcome: "ambiguous", paymentAttemptId: dispatchOutcome.anchor.id };
      }
    }
  }

  /**
   * Fenced by the retry's OWN CURRENT executionToken, read fresh — mirrors `markRetryFired`'s own
   * doc comment. A safe no-op if the retry is no longer `claimed` under that token.
   *
   * R11 PASS B1 — FINAL CORRECTION (Defect 4 — CALLERS MUST NOT CONTINUE AFTER REFUSAL): NEVER
   * writes `resultingPaymentAttemptId` itself — every caller of this method calls
   * `repairLegacyLineageAndApply` first, which OWNS that write exclusively (atomically, null-or-same
   * — see that method's own doc comment). This method previously also unconditionally wrote
   * `resultingPaymentAttemptId` here, which could silently RE-overwrite it with a candidate
   * `repairLegacyLineageAndApply` had just correctly REFUSED (a `"conflict"` disposition) — this
   * bookkeeping-only version marks `status`/`firedAt` alone, never touching that column.
   */
  private async markRetryFiredIfClaimed(retryId: string): Promise<void> {
    const db = this.db;
    const rows = await db.select({ executionToken: paymentRetry.executionToken }).from(paymentRetry).where(eq(paymentRetry.id, retryId)).limit(1);
    const executionToken = rows[0]?.executionToken;
    if (!executionToken) return;
    await db
      .update(paymentRetry)
      .set({ status: "fired", firedAt: new Date() })
      .where(and(eq(paymentRetry.id, retryId), eq(paymentRetry.executionToken, executionToken), eq(paymentRetry.status, "claimed")));
  }

  /**
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2; Stage 9 remediation, Root
   * Correction 2). Shared core of "the provider recognizes this idempotency key" — used by BOTH
   * `resolveAmbiguousRetry` (asynchronous scheduler resumption) and `dispatchProviderCallForAnchor`'s
   * own post-dispatch completion step (never trusting `createPayment`'s own synchronous response for
   * terminal handling — see that method's own doc comment). Persists `providerPaymentId` correlation
   * (pure identity correlation — always safe, idempotent, independent of any concurrent status race),
   * then routes a TERMINAL outcome through `effectApplier.receiveInternalEvent` — the EXACT SAME
   * durable claim + required-effect pipeline (legal transition validation, audit, ledger, installment
   * workflow, agreement lifecycle) a real webhook delivery uses — NEVER a direct status write; a
   * NON-terminal ("pending") outcome only ever conditionally advances `submitted -> processing`.
   * Marks the retry `fired` on any outcome here (terminal or not) — mirrors `claimAndExecuteRetry`'s
   * own "fired" semantics: "a definite response was durably obtained from the provider", not "the
   * payment has definitively settled."
   */
  private async resolveSubmittedAnchor(
    existing: typeof paymentAttempt.$inferSelect,
    retryId: string,
    retryExecutionToken: string | null,
    provider: PaymentProvider,
    effectApplier: ProviderOutcomeEffectApplier,
  ): Promise<ResolveAmbiguousResult> {
    const found = await provider.retrievePaymentByIdempotencyKey(existing.idempotencyKey);
    if (!found) return { outcome: "still_ambiguous" };
    return this.applyFoundOutcome(existing, found, retryId, retryExecutionToken, provider, effectApplier);
  }

  private async applyFoundOutcome(
    existing: typeof paymentAttempt.$inferSelect,
    found: RetrievePaymentResult,
    retryId: string,
    retryExecutionToken: string | null,
    provider: PaymentProvider,
    effectApplier: ProviderOutcomeEffectApplier,
  ): Promise<ResolveAmbiguousResult> {
    const db = this.db;
    // Pure identity correlation — always safe, independent of any concurrent status race, and a
    // PREREQUISITE for a future real webhook (keyed by providerPaymentId) or this method's own
    // synthetic event below to ever find this row at all. Never overwrites an already-set value.
    if (!existing.providerPaymentId) {
      await db
        .update(paymentAttempt)
        .set({ providerPaymentId: found.providerPaymentId })
        .where(and(eq(paymentAttempt.id, existing.id), isNull(paymentAttempt.providerPaymentId)));
    }

    if (found.status === "succeeded" || found.status === "failed") {
      // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 2 — CENTRALIZE
      // PAID2YOU PLATFORM-FEE AUTHORITY): obtained from the SAME injected policy
      // `PaymentWebhookService`'s own normal webhook-receipt ledger posting uses.
      const authoritativePlatformFee = await this.platformFeePolicy.getPlatformFeeMinorUnits({
        amountMinorUnits: existing.amountMinorUnits,
        currency: existing.currency,
        paymentMethod: existing.paymentMethod,
        agreementId: existing.agreementId,
      });
      await effectApplier.receiveInternalEvent({
        provider: provider.providerName,
        providerEventId: `ambiguity-resolution:${existing.idempotencyKey}`,
        eventType: found.status === "succeeded" ? "payment.succeeded" : "payment.failed",
        data: {
          providerPaymentId: found.providerPaymentId,
          amountMinorUnits: found.amountMinorUnits,
          currency: found.currency,
          processorFeeMinorUnits: found.feeMinorUnits,
          platformFeeMinorUnits: authoritativePlatformFee,
        },
      });
    } else {
      // Non-terminal ("pending") — conditional, never regressing/overwriting a status a concurrent
      // real webhook may have already legally advanced past "submitted".
      await db
        .update(paymentAttempt)
        .set({ status: "processing", updatedAt: new Date() })
        .where(and(eq(paymentAttempt.id, existing.id), eq(paymentAttempt.status, "submitted")));
    }

    if (retryExecutionToken) {
      await db
        .update(paymentRetry)
        .set({ status: "fired", resultingPaymentAttemptId: existing.id, firedAt: new Date() })
        .where(and(eq(paymentRetry.id, retryId), eq(paymentRetry.executionToken, retryExecutionToken), eq(paymentRetry.status, "claimed")));
    }
    return { outcome: "fired", resultingPaymentAttemptId: existing.id };
  }

  async resolveAmbiguousRetry(input: {
    retryId: string;
    idempotencyKey: string;
    provider: PaymentProvider;
    effectApplier: ProviderOutcomeEffectApplier;
  }): Promise<ResolveAmbiguousResult> {
    const db = this.db;
    // Deliberately NOT locked — see this method's own interface doc comment for why no NEW external
    // dispatch happens here, so there is nothing for a lock to protect against `coordinateSuccess`.
    const retryRows = await db
      .select({ status: paymentRetry.status, executionToken: paymentRetry.executionToken, installmentScheduleItemId: paymentRetry.installmentScheduleItemId })
      .from(paymentRetry)
      .where(eq(paymentRetry.id, input.retryId))
      .limit(1);
    const retryRow = retryRows[0];
    if (!retryRow || retryRow.status !== "claimed") return { outcome: "not_applicable" };

    const existingRows = await db.select().from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, input.idempotencyKey)).limit(1);
    const existing = existingRows[0];
    if (!existing) return { outcome: "not_applicable" };

    if (existing.status !== "submitted") {
      // R11 PASS B1 — FINAL LEGACY RECOVERY CORRECTION (Defect 1 — CLAIMED LEGACY RETRY RESUMPTION
      // SKIPS APPLICATION): already resolved (by an earlier resolution attempt, or the real webhook
      // itself) — but for an OLD reachable row from before the Phase-A lineage fix,
      // `resultingPaymentAttemptId` may still be null and the correlated partial-payment proposal may
      // still be missing its required application effect (its own success webhook may already be
      // `processed`, making `recoverBatch` unable to help). MUST repair/apply BEFORE this retry loses
      // scheduler eligibility (becomes `fired`) — the two OTHER "already resolved" branches in this
      // class already do this identically; this was the one branch that did not.
      // R11 PASS B1 — FINAL CORRECTION (Defect 4 — CALLERS MUST NOT CONTINUE AFTER REFUSAL): a
      // `"deferred"` disposition leaves this retry `claimed` (never marked `fired`) — its own OWN
      // still-unresolved `nextResolutionAttemptAt`/`findClaimedForResumption` eligibility IS the
      // durable independent repair obligation that guarantees a future pass revisits it; marking it
      // `fired` here would destroy that guarantee for no correctness benefit. NEVER writes
      // `resultingPaymentAttemptId` itself — `repairLegacyLineageAndApply` already owns that write
      // exclusively (atomically, null-or-same); re-writing it here with `existing.id` regardless of
      // outcome would silently undo a `"conflict"` disposition's own deliberate refusal.
      //
      // R11 PASS B1 — SURGICAL FINAL PATCH (Part 2 — DEFERRED MUST NOT RETURN FIRED): the RETURNED
      // outcome must match that same refusal to finalize — `"still_ambiguous"`, the existing
      // nonterminal `ResolveAmbiguousResult`, never `"fired"` — so `PaymentRetryService.fireDueRetries`
      // neither counts this retry as resolved nor skips `markResolutionDeferred`, which is what
      // actually advances `nextResolutionAttemptAt` for this claimed retry.
      const repairDisposition = await this.repairLegacyLineageAndApply(input.retryId, existing.id);
      if (repairDisposition.kind === "deferred") {
        return { outcome: "still_ambiguous" };
      }
      if (retryRow.executionToken) {
        await db
          .update(paymentRetry)
          .set({ status: "fired", firedAt: new Date() })
          .where(and(eq(paymentRetry.id, input.retryId), eq(paymentRetry.executionToken, retryRow.executionToken), eq(paymentRetry.status, "claimed")));
      }
      return { outcome: "fired", resultingPaymentAttemptId: existing.id };
    }

    // R11 PASS B1 — SURGICAL FINAL PATCH (Part 5 — SUBMITTED LEGACY RESUMPTION): a SUBMITTED
    // candidate has not yet cleared — trusting it as this retry's own replacement without first
    // validating/adopting it via the SAME shared identity rules `repairLegacyLineageAndApply` uses
    // would let a corrupted/contradictory candidate be provider-resolved and mutated before its
    // identity was ever checked. The trust decision happens BEFORE any provider call, any
    // `resultingPaymentAttemptId` write, and any proposal application.
    const adoption = await this.validateAndAdoptLegacyReplacement(input.retryId, existing.id);
    if (adoption.kind === "not_applicable") return { outcome: "not_applicable" };
    if (adoption.kind === "conflict") {
      // Durable conflict evidence already recorded by `validateAndAdoptLegacyReplacement` — never
      // provider-resolve `existing` as a trusted replacement, never mutate it from a provider result,
      // never overwrite `resultingPaymentAttemptId`. Left recoverable (never terminal) exactly like
      // every other still-unresolved claimed retry.
      return { outcome: "still_ambiguous" };
    }
    // "adopted" or "already_adopted" — the link is now trustworthy; safe to resolve via the provider.

    const found = await input.provider.retrievePaymentByIdempotencyKey(input.idempotencyKey);
    if (found) {
      return this.applyFoundOutcome(existing, found, input.retryId, retryRow.executionToken, input.provider, input.effectApplier);
    }

    // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1 — PROVIDER LOOKUP RETURNS NOT
    // FOUND): see `resolveNotFoundOutcome`'s own doc comment.
    return this.resolveNotFoundOutcome(existing, retryRow.installmentScheduleItemId, input.retryId, input.provider, input.effectApplier);
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 1 — PROVIDER LOOKUP RETURNS NOT
   * FOUND). A durable intent does NOT prove provider dispatch actually occurred — the provider
   * confirming no record of this idempotency key is genuine, actionable evidence, never blindly
   * treated as "try again forever" nor blindly treated as "safe to resubmit immediately." Re-checks
   * installment/payment eligibility under the SAME installment lock every dispatch attempt uses:
   *   - installment already settled (by another payment) -> close the local intent WITHOUT ever
   *     dispatching (a definite pre-dispatch failure now that settlement has already happened) —
   *     `{ outcome: "closed" }`.
   *   - still eligible (and the overpayment control still passes) -> the provider ITSELF just
   *     confirmed it has no record of this exact key, so dispatch may safely be retried using THE
   *     SAME idempotency key — never a new one. The outcome is then resolved via the SAME
   *     authoritative `retrievePaymentByIdempotencyKey` + `receiveInternalEvent` pipeline every other
   *     dispatch completion uses.
   */
  private async resolveNotFoundOutcome(
    existing: typeof paymentAttempt.$inferSelect,
    installmentScheduleItemId: string,
    retryId: string,
    provider: PaymentProvider,
    effectApplier: ProviderOutcomeEffectApplier,
  ): Promise<ResolveAmbiguousResult> {
    type Outcome =
      | { kind: "already_resolved"; anchor: typeof paymentAttempt.$inferSelect }
      | { kind: "closed" }
      | { kind: "ambiguous" }
      | { kind: "dispatched"; anchor: typeof paymentAttempt.$inferSelect };

    const outcome: Outcome = await this.db.transaction(async (tx) => {
      const installmentRows = await tx
        .select({ status: installmentScheduleItem.status })
        .from(installmentScheduleItem)
        .where(eq(installmentScheduleItem.id, installmentScheduleItemId))
        .for("update")
        .limit(1);
      if (this.hooks?.afterInstallmentLock) await this.hooks.afterInstallmentLock();

      // Re-read the anchor's OWN current status under the lock — a concurrent real webhook or another
      // resolution attempt may have already resolved it since the caller's own read.
      const anchorRows = await tx.select().from(paymentAttempt).where(eq(paymentAttempt.id, existing.id)).limit(1);
      const anchor = anchorRows[0];
      if (!anchor || anchor.status !== "submitted") {
        return { kind: "already_resolved", anchor: anchor ?? existing };
      }

      // R11 PASS B1 (Defect B1-4): authoritative amount-aware satisfaction, never cached status alone
      // — see `coordinateFailure`'s own identical correction for exactly why.
      const notFoundSettlement = await computeInstallmentSettlementWithinTx(tx, installmentScheduleItemId);
      void installmentRows;
      if (notFoundSettlement?.isSatisfied) {
        await tx
          .update(paymentAttempt)
          .set({ status: "failed", failureReason: "The provider has no record of this dispatch and the installment has since been settled by another payment." })
          .where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: "Provider lookup returned not found; the installment was already settled by another payment." })
          .where(eq(paymentRetry.id, retryId));
        return { kind: "closed" };
      }

      const remainingBalance = anchor.agreementId ? await computeRemainingBalanceMinorUnitsWithinTx(tx, anchor.agreementId) : null;
      if (remainingBalance !== null && anchor.amountMinorUnits > remainingBalance) {
        const reason = `This payment of ${anchor.amountMinorUnits} minor units would exceed the agreement's remaining balance of ${remainingBalance} minor units. Overpayment is not permitted.`;
        await tx.update(paymentAttempt).set({ status: "failed", failureReason: reason }).where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: `Firing failed: ${reason}` })
          .where(eq(paymentRetry.id, retryId));
        return { kind: "closed" };
      }
      // R11: see `dispatchProviderCallForAnchor`'s own identical installment-ceiling re-check.
      try {
        await assertWithinInstallmentCeilingWithinTx(tx, installmentScheduleItemId, anchor.amountMinorUnits);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "installment_ceiling_exceeded";
        await tx.update(paymentAttempt).set({ status: "failed", failureReason: reason }).where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: `Firing failed: ${reason}` })
          .where(eq(paymentRetry.id, retryId));
        return { kind: "closed" };
      }

      // See `dispatchProviderCallForAnchor`'s own doc comment on why this try/catch is scoped to ONLY
      // the provider call itself — a failure persisting correlation AFTER a successful response is a
      // POST-DISPATCH / OUTCOME-UNKNOWN failure, never caught/classified here, and propagates uncaught.
      let providerResult;
      try {
        if (this.hooks?.beforeProviderCall) await this.hooks.beforeProviderCall();
        providerResult = await provider.createPayment({
          idempotencyKey: anchor.idempotencyKey,
          amountMinorUnits: anchor.amountMinorUnits,
          currency: anchor.currency,
          payer: { profileKind: anchor.payerProfileKind, profileId: anchor.payerProfileId },
          recipient: { profileKind: anchor.recipientProfileKind, profileId: anchor.recipientProfileId },
        });
      } catch (error) {
        if (error instanceof AmbiguousProviderResponseError) return { kind: "ambiguous" };
        const reason = error instanceof Error ? error.message : "unknown_processor_error";
        await tx.update(paymentAttempt).set({ status: "failed", failureReason: reason }).where(eq(paymentAttempt.id, anchor.id));
        await tx
          .update(paymentRetry)
          .set({ status: "canceled", canceledAt: new Date(), canceledReason: `Firing failed: ${reason}` })
          .where(eq(paymentRetry.id, retryId));
        return { kind: "closed" };
      }

      if (this.hooks?.afterProviderCallBeforePersist) await this.hooks.afterProviderCallBeforePersist();
      if (providerResult.status === "pending") {
        await tx.update(paymentAttempt).set({ status: "processing", providerPaymentId: providerResult.providerPaymentId }).where(eq(paymentAttempt.id, anchor.id));
      } else {
        await tx.update(paymentAttempt).set({ providerPaymentId: providerResult.providerPaymentId }).where(eq(paymentAttempt.id, anchor.id));
      }
      return { kind: "dispatched", anchor };
    });

    switch (outcome.kind) {
      case "closed":
        return { outcome: "closed" };
      case "ambiguous":
        return { outcome: "still_ambiguous" };
      case "already_resolved": {
        if (outcome.anchor.status === "submitted") return { outcome: "still_ambiguous" };
        const repairDisposition = await this.repairLegacyLineageAndApply(retryId, outcome.anchor.id);
        // R11 PASS B1 — SURGICAL FINAL PATCH (Part 2 — DEFERRED MUST NOT RETURN FIRED): same rule as
        // every other branch calling `repairLegacyLineageAndApply` before terminal bookkeeping.
        if (repairDisposition.kind === "deferred") {
          return { outcome: "still_ambiguous" };
        }
        await this.markRetryFiredIfClaimed(retryId);
        return { outcome: "fired", resultingPaymentAttemptId: outcome.anchor.id };
      }
      case "dispatched": {
        const retryRows = await this.db.select({ executionToken: paymentRetry.executionToken }).from(paymentRetry).where(eq(paymentRetry.id, retryId)).limit(1);
        return this.resolveSubmittedAnchor(outcome.anchor, retryId, retryRows[0]?.executionToken ?? null, provider, effectApplier);
      }
    }
  }

  async confirmExecutionStillValid(input: { retryId: string; executionToken: string }): Promise<boolean> {
    // Deliberately NOT inside a lock/transaction — this is the mandatory FINAL read immediately
    // before the provider call (see this class's own doc comment for why a full lock cannot be held
    // through an external network call here). It reflects the latest COMMITTED state: if
    // `coordinateSuccess` canceled this retry (even a split second ago), this read observes that.
    const db = this.db;
    const rows = await db
      .select({ status: paymentRetry.status, executionToken: paymentRetry.executionToken })
      .from(paymentRetry)
      .where(eq(paymentRetry.id, input.retryId))
      .limit(1);
    const row = rows[0];
    return row?.status === "claimed" && row.executionToken === input.executionToken;
  }

  async markRetryFired(input: { retryId: string; executionToken: string; resultingPaymentAttemptId: string; firedAt: Date }): Promise<void> {
    const db = this.db;
    // Fenced by BOTH executionToken AND status = "claimed" — `coordinateSuccess` cancelling a
    // "claimed" retry never clears its executionToken (see that method's own doc comment), so the
    // token alone would still "match" a since-canceled row; the status guard is what actually makes
    // a stale worker's finalization attempt a genuine no-op once superseded.
    await db
      .update(paymentRetry)
      .set({ status: "fired", resultingPaymentAttemptId: input.resultingPaymentAttemptId, firedAt: input.firedAt })
      .where(and(eq(paymentRetry.id, input.retryId), eq(paymentRetry.executionToken, input.executionToken), eq(paymentRetry.status, "claimed")));
  }

  async markRetryExecutionFailed(input: { retryId: string; executionToken: string; canceledReason: string }): Promise<void> {
    const db = this.db;
    // Fenced by BOTH executionToken AND status = "claimed" — see `markRetryFired`'s own doc comment.
    await db
      .update(paymentRetry)
      .set({ status: "canceled", canceledAt: new Date(), canceledReason: input.canceledReason })
      .where(and(eq(paymentRetry.id, input.retryId), eq(paymentRetry.executionToken, input.executionToken), eq(paymentRetry.status, "claimed")));
  }
}
