import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent } from "@/db/schema";
import type { AuditService } from "@/lib/audit/auditService";
import { ConfigurationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { PaymentAttemptRecord, PaymentAttemptRepository } from "@/lib/payments/paymentService";
import type { PaymentRetryRepository } from "@/lib/failedPayments/paymentRetryService";
import type { PartialPaymentRequestRepository } from "./partialPaymentService";

/** The EXACT, and only, form `POST /api/agreements/partial-payments/initiate-payment` ever mints (`partial-payment-${partialPaymentRequest.id}`). Strictly anchored, shape-validated (a real UUID). */
const PARTIAL_PAYMENT_IDEMPOTENCY_KEY_PATTERN =
  /^partial-payment-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** The EXACT, and only, form retry firing ever mints (`retry-${retryId}` — see `establishDurableDispatchIntent`'s own doc comment and the raw-SQL precedent at `coordinateFailure`'s own `'retry-' || id::text` check). */
const RETRY_IDEMPOTENCY_KEY_PATTERN = /^retry-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Defensive bound on retry-lineage traversal — real chains are always 0-1 hops long in practice; this only guards against ever looping on unexpected/corrupt data. Exhausting it is UNKNOWN, never treated as proof of "not correlated" (Defect 5C). */
const MAX_RETRY_LINEAGE_HOPS = 25;

const SUPERSEDED_STATUSES = new Set(["refunded", "disputed", "returned", "reversed"]);

export interface PartialPaymentLedgerClearedReader {
  findEntry(paymentAttemptId: string, entryType: "payment_cleared"): Promise<unknown>;
}

export type ApplyClearedPaymentOutcome =
  /**
   * SAFE FINALIZATION (Defect 4 — PROVEN_NOT_CORRELATED). This payment attempt's own idempotency key
   * (and, where applicable, its full retry ancestry) proves it has nothing to do with any
   * partial-payment proposal. Always a safe no-op — the caller may finalize normally.
   */
  | { outcome: "not_correlated" }
  /**
   * RETRYABLE (Defect 4 — NOT_YET_DURABLE). Correlated to a proposal, but no durable
   * `payment_cleared` ledger entry exists yet for this exact attempt — genuinely transient (still in
   * flight) or a dead end (failed without ever clearing). The caller MUST keep this retryable
   * (never finalize as though application completed) — see `PaymentWebhookService
   * .applyPartialPaymentRequired`'s own doc comment.
   */
  | { outcome: "not_yet_durable"; partialPaymentRequestId: string }
  /** SAFE FINALIZATION (APPLIED). This call performed the `awaiting_payment -> applied` transition just now. */
  | { outcome: "applied"; partialPaymentRequestId: string }
  /** SAFE FINALIZATION (ALREADY_APPLIED). The proposal was already durably applied to this EXACT payment attempt — a safe, successful no-op (duplicate webhook/recovery replay). */
  | { outcome: "already_applied"; partialPaymentRequestId: string }
  /**
   * SAFE FINALIZATION, once durable evidence has been recorded (Defect 4A — CONFLICT/DATA
   * INCONSISTENCY). Covers: a `partial-payment-<id>` key whose proposal record is missing; an
   * agreement/installment/amount mismatch against the proposal's own approved terms; the proposal
   * already durably applied to a DIFFERENT attempt; or the proposal in some other, non-recoverable
   * status (e.g. legitimately expired) at the moment a durably-cleared, correlated payment was
   * found. Retrying the SAME webhook event can never correct any of these — durable
   * reconciliation/audit evidence is written FIRST (see `recordConflictEvidence`), then this is
   * returned so the caller finalizes rather than retrying forever.
   */
  | { outcome: "conflict"; partialPaymentRequestId?: string };

export interface PartialPaymentAutoApplicationServiceDeps {
  requests: PartialPaymentRequestRepository;
  payments: PaymentAttemptRepository;
  retries: PaymentRetryRepository;
  ledger: PartialPaymentLedgerClearedReader;
  audit: AuditService;
}

type LineageResolution =
  | { kind: "correlated"; partialPaymentRequestId: string }
  | { kind: "not_correlated" }
  /** Defect 4/5 — RETRYABLE. Traversal exhausted its bound, a referenced ancestor is missing/corrupt, or a retry-shaped key's own retry row cannot be found — NEVER conflated with "proven not a partial payment." */
  | { kind: "unknown" }
  /** Defect 4A/5B — a `partial-payment-<id>` key whose proposal record is missing: a correlated DATA INCONSISTENCY, never "not correlated." */
  | { kind: "missing_proposal"; partialPaymentRequestId: string };

/**
 * R11 PASS B1 — FINAL LIFECYCLE CLOSURE. Resolves an already-succeeded (or supersession-superseded)
 * payment attempt back to the proposal that funded it — using ONLY the server's own persisted,
 * structurally-validated data, never client input, never a loosely parsed arbitrary string:
 *
 *   - the exact `partial-payment-<uuid>` idempotencyKey form the initiation route mints, directly; or
 *   - the exact `retry-<uuid>` idempotencyKey form retry firing mints — walked BACKWARD by parsing
 *     the retryId directly out of the key and looking the retry row up BY ITS OWN ID
 *     (`PaymentRetryRepository.findById`), NEVER by querying `resultingPaymentAttemptId` (Defect 1/5
 *     — this is what makes lineage resolution robust regardless of whether that column has ever been
 *     populated for this row: the id-keyed lookup depends on nothing but the retry row's own,
 *     always-set `originalPaymentAttemptId`, so even a LEGACY row from before
 *     `establishDurableDispatchIntent`'s Phase-A write existed resolves correctly here).
 *
 * Defect 5's classification is load-bearing for the caller's own finalize-vs-retry decision:
 *   - no key match at all -> `not_correlated` (proven, safe to finalize).
 *   - `retry-<id>` key, but NO retry row with that id exists -> `unknown` (never "not correlated").
 *   - `partial-payment-<id>` key, but NO proposal row with that id exists -> `missing_proposal` (a
 *     correlated data inconsistency, never "not correlated" — see Defect 5B).
 *   - bound exhausted, or an ancestor id is referenced but missing -> `unknown`.
 */
async function resolveLineage(deps: PartialPaymentAutoApplicationServiceDeps, attempt: PaymentAttemptRecord): Promise<LineageResolution> {
  let current: PaymentAttemptRecord = attempt;
  for (let hop = 0; hop < MAX_RETRY_LINEAGE_HOPS; hop++) {
    const directMatch = PARTIAL_PAYMENT_IDEMPOTENCY_KEY_PATTERN.exec(current.idempotencyKey);
    if (directMatch) {
      const partialPaymentRequestId = directMatch[1] ?? "";
      const request = await deps.requests.findById(partialPaymentRequestId);
      if (!request) return { kind: "missing_proposal", partialPaymentRequestId };
      return { kind: "correlated", partialPaymentRequestId };
    }
    const retryMatch = RETRY_IDEMPOTENCY_KEY_PATTERN.exec(current.idempotencyKey);
    if (!retryMatch) return { kind: "not_correlated" }; // proven: neither correlation form at all.
    const retryId = retryMatch[1] ?? "";
    const retryRow = await deps.retries.findById(retryId);
    if (!retryRow) return { kind: "unknown" }; // retry-shaped key, no matching row — fail safe (Defect 5A/5C).
    const next = await deps.payments.findById(retryRow.originalPaymentAttemptId);
    if (!next) return { kind: "unknown" }; // referenced but missing — corrupt/unexpected, fail safe.
    current = next;
  }
  return { kind: "unknown" }; // bound reached while a chain still continued — exhaustion, never "not correlated".
}

/**
 * R11 PASS B1 — FINAL LIFECYCLE CLOSURE (architectural decision — PROPOSAL CONSUMPTION). Wired into
 * `PaymentWebhookService.applyEvent` (see that class's own `partialPaymentApplication` dependency)
 * immediately after a `"payment.succeeded"` event's own `payment_cleared` ledger entry has durably
 * posted — never before, and never as a client/API follow-up call. Also invoked directly by
 * `DrizzleFailedPaymentRetryCoordinator`'s own legacy-lineage repair path (Defect 1B) for a
 * webhook event that is already `processed` and thus ineligible for `recoverBatch`.
 *
 * PROPOSAL CONSUMPTION (Defect 3, architectural decision): once the correlated attempt has durable
 * HISTORICAL `payment_cleared` evidence, the proposal is CONSUMED — it becomes (and stays) `applied`
 * with the exact `paymentAttemptId` stored, even if that payment is LATER reversed, refunded,
 * disputed, or returned. "Applied" means "was actually used by a payment that durably cleared," NOT
 * "money is still currently effective" — current financial truth (whether the installment is still
 * satisfied) remains controlled exclusively by ledger/payment status/amount-aware settlement/
 * `coordinateSupersession`; this class never re-derives or alters it, and never marks anything
 * satisfied merely because a proposal became applied. If the attempt is CURRENTLY superseded at the
 * moment of application, the existing durable supersession evidence is ALSO recorded here (audit
 * trail only) — but the proposal itself still becomes applied, never left `awaiting_payment`. A
 * reversed/refunded proposal is never payable/reusable again and never triggers an automatic
 * replacement charge — the reopened balance (if any) is handled entirely by the normal, separately-
 * authorized Make Payment/installment flow.
 *
 * OUTCOME CONTRACT (Defect 4) — see `ApplyClearedPaymentOutcome`'s own per-member doc comments:
 * `applied`/`already_applied`/`not_correlated`/`conflict` are all SAFE FINALIZATION (a normal
 * return); `not_yet_durable` and an `unknown`-lineage resolution (thrown) are RETRYABLE — the
 * caller's required-effect pipeline must never finalize an event that returned/threw retryable.
 *
 * CONFLICT/DATA INCONSISTENCY (Defect 4A/5B): a recognized-but-inconsistent correlation (a
 * `partial-payment-<id>` key with no matching proposal, an agreement/installment/amount mismatch, an
 * already-applied-to-a-different-attempt race, or a durably-cleared payment found for a proposal no
 * longer in an applicable status) durably records reconciliation evidence (via the existing
 * `AuditService`, deduplicated per `(targetResourceType, targetResourceId, action)` so a duplicate
 * webhook/recovery replay never appends unlimited duplicate evidence) BEFORE finalizing — never a
 * bare `logger.error` and return.
 */
export class PartialPaymentAutoApplicationService {
  constructor(private readonly deps: PartialPaymentAutoApplicationServiceDeps) {}

  async applyClearedPayment(paymentAttemptId: string): Promise<ApplyClearedPaymentOutcome> {
    const attempt = await this.deps.payments.findById(paymentAttemptId);
    if (!attempt) return { outcome: "not_correlated" };

    const resolution = await resolveLineage(this.deps, attempt);
    if (resolution.kind === "not_correlated") return { outcome: "not_correlated" };
    if (resolution.kind === "unknown") {
      // Defect 4/5 — RETRYABLE: never silently concluded "not a partial payment."
      throw new ConfigurationError("partial_payment_lineage_resolution_unknown_or_exhausted");
    }
    if (resolution.kind === "missing_proposal") {
      await this.recordConflictEvidence("partial_payment_key_missing_proposal", attempt, resolution.partialPaymentRequestId);
      return { outcome: "conflict", partialPaymentRequestId: resolution.partialPaymentRequestId };
    }
    const partialPaymentRequestId = resolution.partialPaymentRequestId;

    // PROPOSAL CONSUMPTION (Defect 3): historical clearing wins — never gated on the attempt's
    // CURRENT status. If it never durably cleared at all, there is nothing to consume the proposal
    // with yet (genuinely retryable — see `not_yet_durable`'s own doc comment).
    const cleared = await this.deps.ledger.findEntry(attempt.id, "payment_cleared");
    if (!cleared) return { outcome: "not_yet_durable", partialPaymentRequestId };

    const request = await this.deps.requests.findById(partialPaymentRequestId);
    if (!request) {
      await this.recordConflictEvidence("partial_payment_key_missing_proposal", attempt, partialPaymentRequestId);
      return { outcome: "conflict", partialPaymentRequestId };
    }
    if (request.agreementId !== attempt.agreementId) {
      await this.recordConflictEvidence("agreement_mismatch", attempt, partialPaymentRequestId);
      return { outcome: "conflict", partialPaymentRequestId };
    }
    if (request.installmentScheduleItemId && request.installmentScheduleItemId !== attempt.installmentScheduleItemId) {
      await this.recordConflictEvidence("installment_mismatch", attempt, partialPaymentRequestId);
      return { outcome: "conflict", partialPaymentRequestId };
    }
    if (request.proposedAmountMinorUnits !== attempt.amountMinorUnits) {
      await this.recordConflictEvidence("amount_mismatch", attempt, partialPaymentRequestId);
      return { outcome: "conflict", partialPaymentRequestId };
    }

    const isCurrentlySuperseded = SUPERSEDED_STATUSES.has(attempt.status);

    const result = await this.deps.requests.applyIfAwaitingPayment(partialPaymentRequestId, attempt.id);
    if (result.outcome === "applied" || result.outcome === "already_applied_same") {
      if (isCurrentlySuperseded) {
        // Defect 3A/3B: the proposal is consumed either way — this is purely an audit/history
        // record of the fact that the money it was consumed by has SINCE been superseded. Never
        // touches ledger settlement, never marks the installment satisfied, never reopens/revokes
        // the proposal's own `applied` status.
        //
        // R11 PASS B1 — FINAL CORRECTION (Defect 7 — TRANSIENT FAILURE MUST REMAIN RECOVERABLE): this
        // annotation is NOT itself a required financial effect — the required effect (the proposal
        // durably `applied` to the exact historically-cleared attempt) already committed on the line
        // above. A failure writing this best-effort supplementary audit trail must never make an
        // otherwise-successful required effect look incomplete/thrown to its caller — that would hide
        // the real required effect from ever completing (its own candidate-selection query is keyed
        // on proposal status, which is already correctly `applied` by this point) while contributing
        // nothing recoverable in return. Logged and swallowed; never re-thrown.
        try {
          await this.recordSupersessionHistoryEvidence(attempt, partialPaymentRequestId);
        } catch (error) {
          logger.error("partial_payment_auto_application_supersession_evidence_failed", {
            partialPaymentRequestId,
            paymentAttemptId: attempt.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { outcome: result.outcome === "applied" ? "applied" : "already_applied", partialPaymentRequestId };
    }
    if (result.outcome === "already_applied_different") {
      await this.recordConflictEvidence("already_applied_to_different_attempt", attempt, partialPaymentRequestId, {
        existingPaymentAttemptId: result.request.paymentAttemptId,
      });
      return { outcome: "conflict", partialPaymentRequestId };
    }
    // "not_awaiting_payment" — e.g. the proposal legitimately expired (Defect 2's own corrected,
    // agreement-lock-serialized protocol) in the narrow window before this exact clearing became
    // durable. The payment itself remains fully tracked in payment_attempt/ledger; only its link to
    // this proposal is what is correctly never created — but durably recorded for reconciliation
    // visibility (Defect 4A), never silently dropped.
    await this.recordConflictEvidence("proposal_not_awaiting_payment", attempt, partialPaymentRequestId, {
      requestStatus: result.request.status,
    });
    return { outcome: "conflict", partialPaymentRequestId };
  }

  /**
   * Defect 4A/3B — durable, deduplicated reconciliation evidence. Checked-then-inserted against the
   * existing `audit_event` table, keyed on `(targetResourceType, targetResourceId, action)` — a
   * duplicate webhook/recovery replay of the SAME conflict finds the existing row and skips, so
   * evidence never accumulates without bound.
   */
  private async recordConflictEvidence(
    conflictType: string,
    attempt: PaymentAttemptRecord,
    partialPaymentRequestId: string | undefined,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const action = "partial_payment_application_conflict";
    const targetResourceId = partialPaymentRequestId ?? attempt.id;
    logger.error("partial_payment_auto_application_conflict", {
      conflictType,
      partialPaymentRequestId,
      paymentAttemptId: attempt.id,
      agreementId: attempt.agreementId,
      ...extra,
    });
    const already = await this.hasExistingAuditRecord("partial_payment_request", targetResourceId, action);
    if (already) return;
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: attempt.payerProfileKind,
      profileId: attempt.payerProfileId,
      agreementId: attempt.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { conflictType, paymentAttemptId: attempt.id, installmentScheduleItemId: attempt.installmentScheduleItemId, amountMinorUnits: attempt.amountMinorUnits, ...extra },
      reason: `Partial-payment application conflict: ${conflictType}.`,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "partial_payment_request",
      targetResourceId,
    });
  }

  /** Defect 3A/3B — records that the proposal's consuming payment was later superseded. Exact-once per attempt via the same deduplication technique as `recordConflictEvidence`. */
  private async recordSupersessionHistoryEvidence(attempt: PaymentAttemptRecord, partialPaymentRequestId: string): Promise<void> {
    const action = "partial_payment_consuming_payment_superseded";
    const already = await this.hasExistingAuditRecord("partial_payment_request", partialPaymentRequestId, action);
    if (already) return;
    logger.error("partial_payment_auto_application_superseded_after_consumption", {
      partialPaymentRequestId,
      paymentAttemptId: attempt.id,
      attemptStatus: attempt.status,
    });
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: attempt.payerProfileKind,
      profileId: attempt.payerProfileId,
      agreementId: attempt.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { paymentAttemptId: attempt.id, attemptStatus: attempt.status },
      reason: `The payment that consumed this partial-payment proposal was later ${attempt.status}. The proposal remains applied/consumed — financial reopening (if any) is handled exclusively by coordinateSupersession and the normal payment flow.`,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "partial_payment_request",
      targetResourceId: partialPaymentRequestId,
    });
  }

  /**
   * Defect 3B — "Duplicate webhook/recovery must not append unlimited duplicate audit evidence."
   * A plain existence check (never a full atomic idempotency primitive — this is a best-effort audit
   * trail, not a financial effect) against the SAME `(targetResourceType, targetResourceId, action)`
   * this codebase's own `audit_event` rows are already conventionally queried by elsewhere. Any
   * existing row for this exact triple is treated as sufficient — a genuinely different conflict
   * TYPE recorded later for the same proposal is intentionally not separately re-recorded, keeping
   * this bounded (never unlimited) rather than unboundedly granular.
   */
  private async hasExistingAuditRecord(targetResourceType: string, targetResourceId: string, action: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, targetResourceType), eq(auditEvent.targetResourceId, targetResourceId), eq(auditEvent.action, action)))
      .limit(1);
    return rows.length > 0;
  }
}
