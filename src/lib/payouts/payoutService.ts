import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ProviderNotAvailableError, ValidationError } from "@/lib/errors";
import type { LedgerService } from "@/lib/ledger/ledgerService";
import type { PaymentAttemptRepository } from "@/lib/payments/paymentService";
import type { AtomicPayoutConfirmer } from "./atomicPayoutConfirmer";
import type { AtomicPayoutReturner } from "./atomicPayoutReturner";
import type { PayoutAttemptRecord, PayoutAttemptRepository } from "./payoutAttemptRepository";

/**
 * PAID2YOU — B0-D PHASE 3A (eliminate fictional payouts). The SOLE place a creditor payout may ever
 * be marked confirmed, failed, or returned — see `payout_attempt`'s own doc comment
 * (src/db/schema/payoutAttempt.ts) for the full design rationale this class implements.
 *
 * `LedgerService.postPayout`/`postPayoutReturn` and `PaymentAttemptRepository.markPayoutCompleted` are
 * NEVER called from anywhere else in this codebase — `PaymentWebhookService` (the only other class
 * that used to touch them, via the now-removed `payout.paid` -> `applyPayoutRequired` mechanism) only
 * ever calls `recordPayoutOwed` below, which never itself completes anything.
 *
 * Lifecycle: `pending` (recorded the moment a payment clears — nothing provider-confirmed yet) ->
 * `confirmed` (via `confirmPayout`, which REQUIRES non-empty, caller-supplied provider evidence — a
 * bare event arriving is never sufficient) | `failed` (via `failPayout` — the creditor's own
 * `creditor_proceeds_payable` liability is left completely untouched); `confirmed` -> `returned` (via
 * `returnPayout`, reinstating the liability).
 *
 * FAIL-CLOSED BY CONSTRUCTION, NOT BY RUNTIME CHECK ALONE: no code path anywhere in this codebase
 * calls `confirmPayout`, `failPayout`, or `returnPayout` today — B0-D has no live payout provider (no
 * Adyen account, no Balance Platform/Legal Entity Management/Transfers API integration). These methods
 * exist as provider-independent infrastructure a future live-provider integration wires a real,
 * verified trigger into — this phase deliberately invents no Adyen event mapping or finality rule for
 * what that trigger should be.
 *
 * PAID2YOU — B0-D PHASE 3B (payout integrity): on top of that structural fact, `confirmPayout` ALSO
 * enforces a SECOND, INDEPENDENT runtime gate — `payoutProviderIntegrationVerified` (sourced from
 * `PAYOUT_PROVIDER_INTEGRATION_VERIFIED`; see that env var's own doc comment in `src/config/env.ts`).
 * Non-empty `providerName`/`providerPayoutReference` alone only proves a CALLER claims a provider
 * confirmed something — this flag is the only thing that says Paid2You has actually integrated a live,
 * authenticated payout-confirmation signal from a real provider at all. So even once a future webhook
 * or route DOES wire a real trigger into `confirmPayout`, that wiring alone still cannot complete a
 * payout until an operator has explicitly flipped this flag after confirming the integration is real —
 * defense in depth against exactly the kind of "syntactically-valid-looking but never actually
 * provider-verified" completion this whole phase exists to close.
 */
export class PayoutService {
  constructor(
    private readonly deps: {
      payoutAttempts: PayoutAttemptRepository;
      ledger: LedgerService;
      payments: Pick<PaymentAttemptRepository, "markPayoutCompleted" | "clearPayoutCompleted">;
      audit: AuditService;
      /**
       * PAID2YOU — B0-D PHASE 3B (payout integrity): mirrors `BankConnectionService`'s identical
       * `adyenMerchantAccount`-style pattern of injecting a resolved env value rather than the whole
       * `ServerEnv` object — production wiring (`getPayoutService.ts`) passes
       * `getServerEnv().PAYOUT_PROVIDER_INTEGRATION_VERIFIED`; test wiring (`testFakes.ts`) defaults it
       * to `true` so every pre-existing test that exercises real payout completion is unaffected, with
       * this phase's own tests overriding it to `false` to prove the gate.
       */
      payoutProviderIntegrationVerified: boolean;
      /**
       * PAID2YOU — B0-D PHASE 3B (G2/G3 correction: atomic confirmation/return). Optional, mirroring
       * `PaymentService`'s identical `atomicManualPayments?: AtomicManualPaymentPoster` pattern — every
       * production call site (`getPayoutService.ts`) always wires the real `DrizzleAtomicPayoutConfirmer`/
       * `DrizzleAtomicPayoutReturner`; only the pre-existing in-memory unit-test harness
       * (`testFakes.ts`'s `createTestPayoutService`, which exercises business logic — validation rules,
       * idempotency, ledger balance math — against fakes, never real transactions/locking) leaves these
       * unset and falls back to this class's own sequential logic below. See `confirmPayout`'s and
       * `returnPayout`'s own doc comments for exactly which branch runs when.
       */
      atomicConfirmer?: AtomicPayoutConfirmer;
      atomicReturner?: AtomicPayoutReturner;
    },
  ) {}

  /**
   * Called ONLY once a payment's own `payment_cleared` ledger entry is durably known to exist (see
   * `PaymentWebhookService`'s own doc comment) — records that a payout is now OWED to the creditor, in
   * `"pending"` status. NEVER itself posts anything to the ledger, never marks anything paid. Idempotent:
   * a redelivered/retried webhook that reaches this a second time for the same `paymentAttemptId`
   * returns the existing row unchanged rather than inserting a duplicate (mirrors
   * `LedgerService.insertIdempotently`'s identical insert-then-recheck-on-conflict shape).
   */
  async recordPayoutOwed(input: { paymentAttemptId: string; agreementId: string }): Promise<PayoutAttemptRecord> {
    const existing = await this.deps.payoutAttempts.findByPaymentAttemptId(input.paymentAttemptId);
    if (existing) return existing;
    try {
      return await this.deps.payoutAttempts.insert(input);
    } catch (error) {
      const raced = await this.deps.payoutAttempts.findByPaymentAttemptId(input.paymentAttemptId);
      if (raced) return raced;
      throw error;
    }
  }

  /**
   * The ONLY way a payout may ever be marked complete. Requires an EXISTING `"pending"` payout_attempt
   * (never creates one implicitly — a caller cannot skip `recordPayoutOwed`) and requires non-empty
   * `providerName`/`providerPayoutReference` — generic, provider-agnostic evidence that SOME real
   * transfer was actually confirmed by SOME provider, never assumed from the caller's mere intent to
   * call this method. Idempotent: an already-`"confirmed"` attempt is returned unchanged, and
   * `LedgerService.postPayout`'s own idempotent get-or-post makes a concurrent/duplicate call safe
   * even if it somehow raced past the status check.
   *
   * PAID2YOU — B0-D PHASE 3B (payout integrity): checked FIRST, before touching any repository —
   * `payoutProviderIntegrationVerified` must be `true` or this throws `ProviderNotAvailableError`,
   * regardless of how complete/valid the caller-supplied evidence looks and regardless of whether a
   * `"pending"` attempt even exists. See this class's own doc comment for why this is a second,
   * independent gate rather than something the `providerName`/`providerPayoutReference` checks below
   * already cover. This gate runs identically regardless of which branch below executes.
   *
   * PAID2YOU — B0-D PHASE 3B (G2 correction): when `this.deps.atomicConfirmer` is wired (always true
   * in production — see `getPayoutService.ts`), the claim/ledger-post/mark/set sequence below is
   * entirely replaced by ONE delegated call into `DrizzleAtomicPayoutConfirmer.confirmAtomically`,
   * which performs all four operations inside a single database transaction with row-lock-based
   * concurrency control — see that class's own doc comment for the full mechanism. The sequential,
   * multi-statement logic further below runs ONLY when no atomic confirmer is wired (the pre-existing
   * in-memory unit-test harness).
   */
  async confirmPayout(input: { paymentAttemptId: string; providerName: string; providerPayoutReference: string }): Promise<PayoutAttemptRecord> {
    if (!this.deps.payoutProviderIntegrationVerified) {
      throw new ProviderNotAvailableError(
        "Payout confirmation requires PAYOUT_PROVIDER_INTEGRATION_VERIFIED=true — no live, authenticated payout-confirmation integration has been confirmed for this environment (an operator-level fact this codebase cannot verify itself). See PAYOUT_PROVIDER_INTEGRATION_VERIFIED's own doc comment in src/config/env.ts.",
      );
    }
    if (!input.providerName.trim() || !input.providerPayoutReference.trim()) {
      throw new ValidationError("confirmPayout requires a non-empty providerName and providerPayoutReference — a payout may never be confirmed without real provider evidence.");
    }

    if (this.deps.atomicConfirmer) {
      const result = await this.deps.atomicConfirmer.confirmAtomically(input);
      if (result.outcome === "already_confirmed") return result.record;
      await this.deps.audit.record({
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: null,
        profileId: null,
        agreementId: result.record.agreementId,
        action: "payout_confirmed",
        occurredAt: result.payoutCompletedAt.toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: { providerName: input.providerName, providerPayoutReference: input.providerPayoutReference, payoutCompletedAt: result.payoutCompletedAt },
        reason: null,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payout_attempt",
        targetResourceId: result.record.id,
      });
      return result.record;
    }

    // Fallback (non-atomic) path — see this method's own doc comment for exactly when this runs.
    const attempt = await this.deps.payoutAttempts.findByPaymentAttemptId(input.paymentAttemptId);
    if (!attempt) {
      throw new ValidationError("Cannot confirm a payout that was never recorded as owed.");
    }
    if (attempt.status === "confirmed") return attempt;
    if (attempt.status !== "pending") {
      throw new ValidationError(`Cannot confirm a payout_attempt in status "${attempt.status}" — only "pending" may be confirmed.`);
    }

    await this.deps.ledger.postPayout({ paymentAttemptId: input.paymentAttemptId });
    const confirmedAt = new Date();
    const updated = await this.deps.payoutAttempts.markConfirmed(attempt.id, {
      confirmedAt,
      providerName: input.providerName,
      providerPayoutReference: input.providerPayoutReference,
    });
    const payment = await this.deps.payments.markPayoutCompleted(input.paymentAttemptId, confirmedAt);
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: null,
      profileId: null,
      agreementId: attempt.agreementId,
      action: "payout_confirmed",
      occurredAt: confirmedAt.toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { providerName: input.providerName, providerPayoutReference: input.providerPayoutReference, payoutCompletedAt: payment.payoutCompletedAt },
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payout_attempt",
      targetResourceId: updated.id,
    });
    return updated;
  }

  /**
   * Marks a payout as unable to be completed — deliberately posts NOTHING to the ledger, so the
   * creditor's own `creditor_proceeds_payable` liability from `payment_cleared` is left completely
   * intact (the concrete mechanism behind "failed payout preserves creditor liability"). Idempotent:
   * an already-`"failed"` attempt returns unchanged.
   */
  async failPayout(input: { paymentAttemptId: string; reason: string }): Promise<PayoutAttemptRecord> {
    const attempt = await this.deps.payoutAttempts.findByPaymentAttemptId(input.paymentAttemptId);
    if (!attempt) {
      throw new ValidationError("Cannot fail a payout that was never recorded as owed.");
    }
    if (attempt.status === "failed") return attempt;
    if (attempt.status !== "pending") {
      throw new ValidationError(`Cannot fail a payout_attempt in status "${attempt.status}" — only "pending" may fail.`);
    }
    const failedAt = new Date();
    const updated = await this.deps.payoutAttempts.markFailed(attempt.id, { failedAt, failureReason: input.reason });
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: null,
      profileId: null,
      agreementId: attempt.agreementId,
      action: "payout_failed",
      occurredAt: failedAt.toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { failureReason: input.reason },
      reason: input.reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payout_attempt",
      targetResourceId: updated.id,
    });
    return updated;
  }

  /**
   * A previously-CONFIRMED payout was reversed by the receiving bank — reinstates the creditor's
   * liability via a `"payout_returned"` ledger correction (flips the original `payout` entry's own
   * postings). Requires the attempt to already be `"confirmed"` — a payout that was never confirmed has
   * nothing to return. Idempotent: an already-`"returned"` attempt returns unchanged.
   *
   * PAID2YOU — B0-D PHASE 3B (G3 correction): when `this.deps.atomicReturner` is wired (always true in
   * production — see `getPayoutService.ts`), the claim/ledger-correction/mark/clear sequence below is
   * entirely replaced by ONE delegated call into `DrizzleAtomicPayoutReturner.returnAtomically`, which
   * performs all four operations — including clearing `payment_attempt.payoutCompletedAt`, which the
   * sequential fallback below ALSO now does via `payments.clearPayoutCompleted` — inside a single
   * database transaction with row-lock-based concurrency control. See that class's own doc comment.
   */
  async returnPayout(input: { paymentAttemptId: string; reason: string }): Promise<PayoutAttemptRecord> {
    if (this.deps.atomicReturner) {
      const result = await this.deps.atomicReturner.returnAtomically(input);
      if (result.outcome === "already_returned") return result.record;
      await this.deps.audit.record({
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: null,
        profileId: null,
        agreementId: result.record.agreementId,
        action: "payout_returned",
        occurredAt: (result.record.returnedAt ?? new Date()).toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: { returnReason: input.reason },
        reason: input.reason,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payout_attempt",
        targetResourceId: result.record.id,
      });
      return result.record;
    }

    // Fallback (non-atomic) path — see this method's own doc comment for exactly when this runs.
    const attempt = await this.deps.payoutAttempts.findByPaymentAttemptId(input.paymentAttemptId);
    if (!attempt) {
      throw new ValidationError("Cannot return a payout that was never recorded as owed.");
    }
    if (attempt.status === "returned") return attempt;
    if (attempt.status !== "confirmed") {
      throw new ValidationError(`Cannot return a payout_attempt in status "${attempt.status}" — only "confirmed" may be returned.`);
    }
    await this.deps.ledger.postPayoutReturn({ paymentAttemptId: input.paymentAttemptId, reason: input.reason });
    const returnedAt = new Date();
    const updated = await this.deps.payoutAttempts.markReturned(attempt.id, { returnedAt, returnReason: input.reason });
    // G3 correction: clear the stale "completed" indicator now that this payout has been reversed.
    await this.deps.payments.clearPayoutCompleted(input.paymentAttemptId);
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "payment_provider",
      profileKind: null,
      profileId: null,
      agreementId: attempt.agreementId,
      action: "payout_returned",
      occurredAt: returnedAt.toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { returnReason: input.reason },
      reason: input.reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payout_attempt",
      targetResourceId: updated.id,
    });
    return updated;
  }

  async getPayoutStatus(paymentAttemptId: string): Promise<PayoutAttemptRecord | null> {
    return this.deps.payoutAttempts.findByPaymentAttemptId(paymentAttemptId);
  }
}
