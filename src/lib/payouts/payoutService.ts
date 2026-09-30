import "server-only";
import type { AuditEventRecord, AuditService } from "@/lib/audit/auditService";
import { CreditorNotVerifiedError, ProviderNotAvailableError, ValidationError } from "@/lib/errors";
import type { LedgerService } from "@/lib/ledger/ledgerService";
import type { PaymentAttemptRepository } from "@/lib/payments/paymentService";
import type { VerificationService } from "@/lib/profiles/verificationService";
import type { AtomicPayoutConfirmer } from "./atomicPayoutConfirmer";
import type { AtomicPayoutReturner } from "./atomicPayoutReturner";
import type { PayoutAttemptRecord, PayoutAttemptRepository } from "./payoutAttemptRepository";

/**
 * PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-05/06/07 — eliminate
 * fictional payouts). The SOLE place a creditor payout may ever be marked confirmed, failed, or
 * returned — see `payout_attempt`'s own doc comment (src/db/schema/payoutAttempt.ts) for the full
 * design rationale this class implements.
 *
 * `LedgerService.postPayout`/`postPayoutReturn` and `PaymentAttemptRepository.markPayoutCompleted` are
 * NEVER called from anywhere else in this codebase — `PaymentWebhookService` only ever calls
 * `recordPayoutOwed` below, which never itself completes anything.
 *
 * Lifecycle: `pending` (recorded the moment a payment clears — nothing provider-confirmed yet) ->
 * `confirmed` (via `confirmPayout`, which REQUIRES non-empty, caller-supplied provider evidence — a
 * bare event arriving is never sufficient) | `failed` (via `failPayout` — the creditor's own
 * `creditor_proceeds_payable` liability is left completely untouched); `confirmed` -> `returned` (via
 * `returnPayout`, reinstating the liability).
 *
 * FAIL-CLOSED BY CONSTRUCTION, NOT BY RUNTIME CHECK ALONE: no code path anywhere in this codebase
 * calls `confirmPayout`, `failPayout`, or `returnPayout` today — this V3 architecture has no live
 * payout provider yet. These methods exist as provider-independent infrastructure a future
 * live-provider integration wires a real, verified trigger into — this deliberately invents no
 * provider-specific event mapping or finality rule for what that trigger should be.
 *
 * On top of that structural fact, `confirmPayout` ALSO enforces a SECOND, INDEPENDENT runtime gate —
 * `payoutProviderIntegrationVerified` (sourced from `PAYOUT_PROVIDER_INTEGRATION_VERIFIED`; see that
 * env var's own doc comment in `src/config/env.ts`). Non-empty `providerName`/`providerPayoutReference`
 * alone only proves a CALLER claims a provider confirmed something — this flag is the only thing that
 * says Paid2You has actually integrated a live, authenticated payout-confirmation signal from a real
 * provider at all. So even once a future webhook or route DOES wire a real trigger into
 * `confirmPayout`, that wiring alone still cannot complete a payout until an operator has explicitly
 * flipped this flag after confirming the integration is real — defense in depth against exactly the
 * kind of "syntactically-valid-looking but never actually provider-verified" completion this whole
 * class exists to close.
 *
 * A THIRD, also-independent gate on `confirmPayout` — the payment's own creditor
 * (`recipientProfileKind`/`recipientProfileId`) must have reached this codebase's FULL
 * identity-verification tier (`VerificationService.isFullyVerified`), looked up fresh on every call,
 * exact-profile-scoped (never a caller-supplied identifier). This is INTERNAL eligibility only — a
 * human-reviewed decision this codebase already makes independently of any payment provider — and is
 * explicitly NOT any provider's own KYC/KYB approval; it neither satisfies nor is satisfied by
 * `payoutProviderIntegrationVerified` above. `recordPayoutOwed`/`failPayout` are deliberately NOT
 * gated by this check: a payment that clears always establishes the creditor's liability and a pending
 * payout obligation, verified or not — only *paying out* requires it.
 */
export class PayoutService {
  constructor(
    private readonly deps: {
      payoutAttempts: PayoutAttemptRepository;
      ledger: LedgerService;
      payments: Pick<PaymentAttemptRepository, "findById" | "markPayoutCompleted" | "clearPayoutCompleted">;
      audit: AuditService;
      /**
       * Required (not optional) — unlike `atomicConfirmer`/`atomicReturner` below, this is a mandatory
       * security control with no legitimate "unwired" state. Production (`getPayoutService.ts`) wires
       * the real `VerificationService`; `testFakes.ts` wires a permissive-by-default stub so every
       * pre-existing test that never exercised this gate is unaffected, with this phase's own tests
       * overriding it.
       */
      verification: Pick<VerificationService, "isFullyVerified">;
      /**
       * Mirrors `BankConnectionService`'s identical pattern of injecting a resolved env value rather
       * than the whole `ServerEnv` object — production wiring (`getPayoutService.ts`) passes
       * `getServerEnv().PAYOUT_PROVIDER_INTEGRATION_VERIFIED`; test wiring (`testFakes.ts`) defaults it
       * to `true` so every pre-existing test that exercises real payout completion is unaffected, with
       * this phase's own tests overriding it to `false` to prove the gate.
       */
      payoutProviderIntegrationVerified: boolean;
      /**
       * Optional, mirroring `PaymentService`'s identical `atomicManualPayments?: AtomicManualPaymentPoster`
       * pattern — every production call site (`getPayoutService.ts`) always wires the real
       * `DrizzleAtomicPayoutConfirmer`/`DrizzleAtomicPayoutReturner`; only the pre-existing in-memory
       * unit-test harness (`testFakes.ts`'s `createTestPayoutService`, which exercises business logic —
       * validation rules, idempotency, ledger balance math — against fakes, never real
       * transactions/locking) leaves these unset and falls back to this class's own sequential logic
       * below. See `confirmPayout`'s and `returnPayout`'s own doc comments for exactly which branch
       * runs when.
       */
      atomicConfirmer?: AtomicPayoutConfirmer;
      atomicReturner?: AtomicPayoutReturner;
      /**
       * Stage 4 (FI-10 remediation): read-only query onto the SAME `audit_event` table
       * `AuditService`/`AuditEventRepository` already write — never a second audit store. Lets
       * `confirmPayout`/`returnPayout` detect and repair a missing required audit event on the
       * `already_confirmed`/`already_returned` idempotent-replay branch (see those methods' own doc
       * comments for the exact failure window this closes). Optional, mirroring `atomicConfirmer`/
       * `atomicReturner`'s own established optionality — every pre-existing test/caller that omits it
       * is unaffected (the replay branch simply skips the repair check, exactly like before this
       * remediation); production wiring (`getPayoutService.ts`) always supplies the real
       * `DrizzleAdminAuditReader`.
       */
      auditFinder?: { listForTarget(targetResourceType: string, targetResourceId: string): Promise<AuditEventRecord[]> };
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
   * Checked FIRST, before touching any repository — `payoutProviderIntegrationVerified` must be `true`
   * or this throws `ProviderNotAvailableError`, regardless of how complete/valid the caller-supplied
   * evidence looks and regardless of whether a `"pending"` attempt even exists. See this class's own
   * doc comment for why this is a second, independent gate rather than something the
   * `providerName`/`providerPayoutReference` checks below already cover. This gate runs identically
   * regardless of which branch below executes.
   *
   * Checked immediately after, ALSO before touching the atomic confirmer or the fallback's own
   * repositories — the payment's own creditor (its authoritative `recipientProfileKind`/
   * `recipientProfileId`, never caller input) must satisfy `VerificationService.isFullyVerified` or
   * this throws `CreditorNotVerifiedError`. Missing, pending, rejected, or a verification recorded for
   * a different profile all fail this the same way — there is no code path where a bare
   * provider-flag pass alone, or a verification belonging to someone other than this specific
   * payment's creditor, is sufficient. Independent of the provider-integration gate above: a
   * fully-verified creditor still cannot be paid out with no live provider wired, and a live provider
   * still cannot pay out an unverified creditor.
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
    await this.requireCreditorEligible(input.paymentAttemptId);

    if (this.deps.atomicConfirmer) {
      const result = await this.deps.atomicConfirmer.confirmAtomically(input);
      // S4-03-FINAL (Stage 4 completion order): the financial confirmation transaction and this
      // audit write are two SEPARATE transactions — a "newly confirmed" caller and an
      // "already_confirmed" replay caller (concurrently confirming/repairing the SAME payout) are
      // racing each other for THIS write, not just racing the financial transition. An unconditional
      // `audit.record()` here — correct only in isolation — would let a genuinely-first caller append
      // a SECOND event after a concurrent replay caller's `ensureRecorded()` already repaired one (or
      // vice versa). Both branches therefore go through the exact same atomic get-or-create, using
      // `result.record`'s own durable, already-persisted facts (never `input`, which may legitimately
      // differ from what was actually confirmed on a replay).
      await this.ensureConfirmationAuditRecorded(result.record);
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
   * Stage 4 (S4-03 / S4-03-FINAL remediation — concurrent payout audit repair is not idempotent):
   * ensures the required `payout_confirmed` audit event exists for `record` — called from BOTH
   * `confirmPayout` branches (a genuinely-new confirmation and an `already_confirmed` replay), never
   * only the replay one. Delegates the existence-check-and-conditional-append to
   * `AuditService.ensureRecorded`, which is atomic (DB-lock-serialized) whenever the underlying
   * repository supports it — every production repository does — so no two callers (whichever branch
   * each is on) can ever both observe absence and both append; exactly one event results, and every
   * other caller observes/reuses it. `auditFinder` is passed through only as the non-atomic
   * fallback's existence check (in-memory test fakes that omit the atomic repository capability);
   * production never reaches that branch.
   */
  private async ensureConfirmationAuditRecorded(record: PayoutAttemptRecord): Promise<void> {
    if (!this.deps.auditFinder) return;
    const identity = { targetResourceType: "payout_attempt", targetResourceId: record.id, action: "payout_confirmed" };
    await this.deps.audit.ensureRecorded(
      identity,
      {
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: null,
        profileId: null,
        agreementId: record.agreementId,
        action: "payout_confirmed",
        occurredAt: (record.confirmedAt ?? new Date()).toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: { providerName: record.providerName, providerPayoutReference: record.providerPayoutReference, payoutCompletedAt: record.confirmedAt },
        reason: null,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payout_attempt",
        targetResourceId: record.id,
      },
      async () => {
        const existing = await this.deps.auditFinder!.listForTarget("payout_attempt", record.id);
        return existing.find((e) => e.action === "payout_confirmed") ?? null;
      },
    );
  }

  /** Stage 4 (S4-03 remediation): the return-side mirror of `ensureConfirmationAuditRecorded` — see that method's own doc comment. */
  private async ensureReturnAuditRecorded(record: PayoutAttemptRecord): Promise<void> {
    if (!this.deps.auditFinder) return;
    const identity = { targetResourceType: "payout_attempt", targetResourceId: record.id, action: "payout_returned" };
    await this.deps.audit.ensureRecorded(
      identity,
      {
        actorUserId: null,
        actorRole: "payment_provider",
        profileKind: null,
        profileId: null,
        agreementId: record.agreementId,
        action: "payout_returned",
        occurredAt: (record.returnedAt ?? new Date()).toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: { returnReason: record.returnReason },
        reason: record.returnReason,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "payout_attempt",
        targetResourceId: record.id,
      },
      async () => {
        const existing = await this.deps.auditFinder!.listForTarget("payout_attempt", record.id);
        return existing.find((e) => e.action === "payout_returned") ?? null;
      },
    );
  }

  /**
   * Resolves the payment's OWN authoritative `recipientProfileKind`/`recipientProfileId` (never a
   * caller-supplied identifier — there is no parameter through which a caller could name a different
   * profile to check) and requires `VerificationService.isFullyVerified` to be `true` for exactly that
   * profile. Throws `CreditorNotVerifiedError` (an instanceof `ValidationError`) otherwise — covering
   * "missing" (no verification record at all), "pending" (submitted, not yet decided), "rejected"
   * (decided against), and "a different profile's verification" (structurally impossible to satisfy by
   * accident, since the lookup is keyed on the payment's own fields) uniformly, with no special-cased
   * bypass for any of them.
   */
  private async requireCreditorEligible(paymentAttemptId: string): Promise<void> {
    const payment = await this.deps.payments.findById(paymentAttemptId);
    if (!payment) {
      throw new ValidationError("Cannot confirm a payout for a payment_attempt that does not exist.");
    }
    const eligible = await this.deps.verification.isFullyVerified(payment.recipientProfileKind, payment.recipientProfileId);
    if (!eligible) {
      throw new CreditorNotVerifiedError();
    }
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
   * When `this.deps.atomicReturner` is wired (always true in production — see `getPayoutService.ts`),
   * the claim/ledger-correction/mark/clear sequence below is entirely replaced by ONE delegated call
   * into `DrizzleAtomicPayoutReturner.returnAtomically`, which performs all four operations —
   * including clearing `payment_attempt.payoutCompletedAt`, which the sequential fallback below ALSO
   * now does via `payments.clearPayoutCompleted` — inside a single database transaction with
   * row-lock-based concurrency control. See that class's own doc comment.
   */
  async returnPayout(input: { paymentAttemptId: string; reason: string }): Promise<PayoutAttemptRecord> {
    if (this.deps.atomicReturner) {
      const result = await this.deps.atomicReturner.returnAtomically(input);
      // S4-03-FINAL (Stage 4 completion order): mirrors confirmPayout's identical unification — see
      // that method's own doc comment for exactly why the "newly returned" and "already_returned"
      // replay branches must share the SAME atomic get-or-create rather than each having their own
      // write path.
      await this.ensureReturnAuditRecorded(result.record);
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
    // Clear the stale "completed" indicator now that this payout has been reversed.
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
