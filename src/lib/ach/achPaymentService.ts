import "server-only";
import { ConflictError, ValidationError } from "@/lib/errors";
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

  /** Submission time reached (docs/PAYMENT_STATE_MACHINE.md §1: "Scheduled → Submitted") — calls the provider. */
  async submitScheduledPayment(paymentAttemptId: string, actingUserId: string): Promise<PaymentAttemptRecord> {
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
        paymentMethod: "ach",
        bankConnectionId: mandate.financialAccountId,
      },
      "scheduled",
    );
    if (scheduled.status !== "scheduled") {
      // Idempotent replay of an already-submitted manual payment — nothing further to do.
      return scheduled;
    }
    return this.deps.payments.submitPending(scheduled.id, input.actingUserId);
  }

  private async requireActiveMandate(agreementId: string): Promise<AchMandateRecord> {
    const active = await this.deps.mandates.getActiveMandate(agreementId);
    if (!active) {
      throw new ValidationError("An active ACH mandate is required before a payment can be scheduled for this agreement.");
    }
    return active;
  }
}
