import "server-only";
import { ConflictError, ProviderNotAvailableError, ValidationError } from "@/lib/errors";
import type { ProfileRef } from "@/lib/payments/paymentProvider";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentService } from "@/lib/payments/paymentService";
import type { AchMandateRecord, AchMandateService } from "./achMandateService";

/**
 * Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md) ACH-specific orchestration on top of Sprint 9's
 * `PaymentService` — never calls `PaymentProvider` directly and never re-implements the
 * idempotency/ownership/verification gate; every payment this class creates still goes through
 * exactly the same `PaymentService.schedulePayment`/`submitPending` gate `createPayment` uses.
 * "First payment" needs no special handling here — it is simply the installment at
 * `sequenceNumber = 0` (Sprint 5), scheduled the same way as any later installment.
 */
export class AchPaymentService {
  constructor(
    private readonly deps: {
      mandates: AchMandateService;
      payments: PaymentService;
      paymentAttempts: PaymentAttemptRepository;
      /**
       * Payment activation gate (SC-10). Required — mirrors `PaymentService`'s identical
       * `newPaymentInitiationVerified` field (this class holds its own copy since `PaymentService`'s
       * own internal deps are private and not reachable from here). Checked in BOTH
       * `submitScheduledPayment` (an installment's FIRST submission) AND `createManualPayment`'s
       * genuinely-new-attempt branch — see each method's own doc comment. `createManualPayment` still
       * creates and submits a BRAND NEW `payment_attempt` row the provider has never seen even when
       * recovering an already-failed installment obligation — leaving it unguarded would be a genuine
       * new-debit bypass reachable via manual-payment and automatic-retry firing alike.
       * `createManualPayment`'s own idempotent-replay branch (an existing, already-submitted attempt
       * found by idempotency key) is correctly exempt — see that method's own doc comment.
       */
      newPaymentInitiationVerified: boolean;
    },
  ) {}

  /**
   * Records a payment as "scheduled" ahead of its actual submission time — used for both the first
   * payment and every recurring installment. Requires an active mandate for the agreement and
   * refuses a second open (unresolved) attempt for the same installment (duplicate-debit
   * prevention; docs/PAYMENT_STATE_MACHINE.md §1.2's "no installment may have more than one open
   * attempt at a time", generalized here beyond just automatic-retry rows). Callers should derive
   * `idempotencyKey` deterministically from `installmentScheduleItemId` (e.g.
   * `ach-schedule-${installmentScheduleItemId}`) so Sprint 9's own DB-unique idempotency constraint
   * is the race-safe backstop behind this pre-check, not just this check alone.
   */
  async scheduleInstallmentPayment(input: {
    idempotencyKey: string;
    installmentScheduleItemId: string;
    agreementId: string;
    payer: ProfileRef;
    recipient: ProfileRef;
    amountMinorUnits: number;
    currency: string;
    actingUserId: string;
  }): Promise<PaymentAttemptRecord> {
    const mandate = await this.requireActiveMandate(input.agreementId);

    const existingOpen = await this.deps.paymentAttempts.findOpenByInstallment(input.installmentScheduleItemId);
    if (existingOpen) {
      throw new ConflictError("An open payment attempt already exists for this installment.");
    }

    return this.deps.payments.schedulePayment(
      {
        idempotencyKey: input.idempotencyKey,
        payer: input.payer,
        recipient: input.recipient,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        agreementId: input.agreementId,
        actingUserId: input.actingUserId,
        installmentScheduleItemId: input.installmentScheduleItemId,
        // Sprint 13 fix: this was never set for ACH, only debit card (Sprint 12) — every
        // payment_attempt this method creates was silently missing the method tag master spec §6
        // requires ("must separately track ACH and card payment states"), and Sprint 13's own retry
        // firing needs it to know which method-specific service to retry through.
        paymentMethod: "ach",
        // Phase 6A Ledger Payment-Source Rule: null when the active mandate has no known internal
        // bank-connection record (a mandate authorized outside the relationship flow).
        bankConnectionId: mandate.financialAccountId,
      },
      "scheduled",
    );
  }

  /**
   * Submission time reached (docs/PAYMENT_STATE_MACHINE.md §1: "Scheduled → Submitted") — calls the
   * provider. Payment activation gate (SC-10): checked FIRST, before `submitPending` ever transitions
   * the row out of "scheduled" — a blocked call produces ZERO mutation. This is the FIRST-EVER
   * submission of this specific payment_attempt (structurally guaranteed non-retryable-into by
   * `submitPending`'s own "only a scheduled payment can be submitted" guard), never a retry.
   */
  async submitScheduledPayment(paymentAttemptId: string, actingUserId: string): Promise<PaymentAttemptRecord> {
    if (!this.deps.newPaymentInitiationVerified) {
      throw new ProviderNotAvailableError(
        "New payment initiation requires PAYMENT_INITIATION_VERIFIED=true — provider registration and valid credentials alone do not constitute operator-confirmed approval to initiate live payments. See PAYMENT_INITIATION_VERIFIED's own doc comment in src/config/env.ts.",
      );
    }
    return this.deps.payments.submitPending(paymentAttemptId, actingUserId);
  }

  /**
   * A debtor- or staff-initiated ad-hoc payment — schedules and submits in one call (there is no
   * future due date to wait for). Still requires an active mandate; still goes through the same
   * verification/idempotency gate. `installmentScheduleItemId` is optional: omitted, this is a
   * general ad-hoc payment not tied to any specific due installment (Sprint 11's original design);
   * provided, it links the payment to the installment it covers — Sprint 13 (docs/sprints/
   * SPRINT_13_FailedPayments_RetryWorkflow.md) needs this so a manual payment that clears a
   * previously-failed installment can cancel that installment's still-pending automatic retry.
   */
  async createManualPayment(input: {
    idempotencyKey: string;
    agreementId: string;
    payer: ProfileRef;
    recipient: ProfileRef;
    amountMinorUnits: number;
    currency: string;
    actingUserId: string;
    installmentScheduleItemId?: string;
    /** R11 (Final Open Issue A — SETTLEMENT EXEMPTION): the ONLY sanctioned way this payment may be created without an installment link against a scheduled agreement. */
    settlementProposalId?: string;
    /** See `RetryPaymentMethodInitiator.createManualPayment`'s own doc comment — passed straight through to `PaymentService.submitPending`. */
    finalGuard?: () => Promise<void>;
  }): Promise<PaymentAttemptRecord> {
    const mandate = await this.requireActiveMandate(input.agreementId);
    const scheduled = await this.deps.payments.schedulePayment(
      {
        idempotencyKey: input.idempotencyKey,
        payer: input.payer,
        recipient: input.recipient,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        agreementId: input.agreementId,
        actingUserId: input.actingUserId,
        installmentScheduleItemId: input.installmentScheduleItemId,
        settlementProposalId: input.settlementProposalId,
        paymentMethod: "ach",
        bankConnectionId: mandate.financialAccountId,
      },
      "scheduled",
    );
    if (scheduled.status !== "scheduled") {
      // Idempotent replay of an already-submitted manual payment — nothing further to do. Never
      // gated: this row already left "scheduled" on a PRIOR call (real provider evidence exists, or
      // is already in flight), so this is recovery of an existing obligation, not a new debit.
      return scheduled;
    }
    // Payment activation gate (SC-10): checked here, not earlier — a `scheduled` status at this point
    // proves the provider has NEVER seen this idempotencyKey. Checked AFTER the replay branch above,
    // so a genuine replay is never blocked, and BEFORE `submitPending` ever transitions the row — a
    // blocked call produces ZERO additional mutation beyond the already-committed "scheduled" row.
    if (!this.deps.newPaymentInitiationVerified) {
      throw new ProviderNotAvailableError(
        "New payment initiation requires PAYMENT_INITIATION_VERIFIED=true — provider registration and valid credentials alone do not constitute operator-confirmed approval to initiate live payments. See PAYMENT_INITIATION_VERIFIED's own doc comment in src/config/env.ts.",
      );
    }
    return this.deps.payments.submitPending(scheduled.id, input.actingUserId, null, null, input.finalGuard);
  }

  /** See `RetryPaymentMethodInitiator.prepareRetrySubmission`'s own doc comment (paymentRetryService.ts). */
  async prepareRetrySubmission(input: { agreementId: string; amountMinorUnits: number; currency: string }): Promise<{
    amountMinorUnits: number;
    currency: string;
    paymentMethod: "ach";
    bankConnectionId: string | null;
  }> {
    const mandate = await this.requireActiveMandate(input.agreementId);
    return {
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      paymentMethod: "ach",
      bankConnectionId: mandate.financialAccountId,
    };
  }

  private async requireActiveMandate(agreementId: string): Promise<AchMandateRecord> {
    const active = await this.deps.mandates.getActiveMandate(agreementId);
    if (!active) {
      throw new ValidationError("An active ACH mandate is required before a payment can be scheduled for this agreement.");
    }
    return active;
  }
}
