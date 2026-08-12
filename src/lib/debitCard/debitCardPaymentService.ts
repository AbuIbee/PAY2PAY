import "server-only";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { ProfileRef } from "@/lib/payments/paymentProvider";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentService } from "@/lib/payments/paymentService";
import type { AgreementFeeAllocationReader } from "./agreementFeeAllocationReader";
import { computeBorrowerSurchargeMinorUnits, computeCardProcessorFeeMinorUnits, SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS } from "./cardFeeAllocation";
import type { DebitCardMethodService } from "./debitCardMethodService";

export interface DebitCardChargeBreakdown {
  scheduledAmountMinorUnits: number;
  cardProcessorFeeMinorUnits: number;
  borrowerSurchargeMinorUnits: number;
  /** The amount actually collected from the payer — scheduledAmountMinorUnits + borrowerSurchargeMinorUnits. */
  totalChargeMinorUnits: number;
}

/**
 * Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md) debit-card-specific orchestration on top
 * of Sprint 9's `PaymentService`, mirroring src/lib/ach/achPaymentService.ts's structure exactly —
 * never calls `PaymentProvider` directly, never re-implements the idempotency/ownership/verification
 * gate. The one thing this class adds beyond ACH's pattern is the fee-allocation surcharge
 * computation (cardFeeAllocation.ts) applied before the amount is handed to PaymentService, and an
 * expired-card pre-flight check (master spec §6: "Debit-card payments may fail, expire").
 */
export class DebitCardPaymentService {
  constructor(
    private readonly deps: {
      cards: DebitCardMethodService;
      payments: PaymentService;
      paymentAttempts: PaymentAttemptRepository;
      feeAllocation: AgreementFeeAllocationReader;
    },
  ) {}

  /**
   * Computes what the payer will actually be charged for a given scheduled amount on this
   * agreement's card, applying the borrower-surcharge rule. Exposed separately from
   * scheduleInstallmentPayment/createManualPayment so callers (routes, UI) can show the borrower the
   * breakdown before they confirm — "must not silently reduce creditor net proceeds" requires the
   * surcharge to be visible, not just applied.
   */
  async computeChargeBreakdown(agreementId: string, scheduledAmountMinorUnits: number): Promise<DebitCardChargeBreakdown> {
    const feeAllocation = await this.deps.feeAllocation.getFeeAllocation(agreementId);
    if (!feeAllocation) {
      throw new ValidationError("This agreement has no fee-allocation term on its current version.");
    }
    const cardProcessorFeeMinorUnits = computeCardProcessorFeeMinorUnits(scheduledAmountMinorUnits);
    const borrowerSurchargeMinorUnits = computeBorrowerSurchargeMinorUnits({
      feeAllocation,
      achEquivalentFeeMinorUnits: SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS,
      cardProcessorFeeMinorUnits,
    });
    return {
      scheduledAmountMinorUnits,
      cardProcessorFeeMinorUnits,
      borrowerSurchargeMinorUnits,
      totalChargeMinorUnits: scheduledAmountMinorUnits + borrowerSurchargeMinorUnits,
    };
  }

  /** Mirrors AchPaymentService.scheduleInstallmentPayment — see that file's doc comment for the shared duplicate-debit-prevention contract. */
  async scheduleInstallmentPayment(input: {
    idempotencyKey: string;
    installmentScheduleItemId: string;
    agreementId: string;
    payer: ProfileRef;
    recipient: ProfileRef;
    amountMinorUnits: number;
    currency: string;
    actingUserId: string;
  }): Promise<PaymentAttemptRecord & { charge: DebitCardChargeBreakdown }> {
    await this.requireActiveUnexpiredCard(input.agreementId);

    const existingOpen = await this.deps.paymentAttempts.findOpenByInstallment(input.installmentScheduleItemId);
    if (existingOpen) {
      throw new ConflictError("An open payment attempt already exists for this installment.");
    }

    const charge = await this.computeChargeBreakdown(input.agreementId, input.amountMinorUnits);
    const record = await this.deps.payments.schedulePayment(
      {
        idempotencyKey: input.idempotencyKey,
        payer: input.payer,
        recipient: input.recipient,
        amountMinorUnits: charge.totalChargeMinorUnits,
        currency: input.currency,
        agreementId: input.agreementId,
        actingUserId: input.actingUserId,
        installmentScheduleItemId: input.installmentScheduleItemId,
        paymentMethod: "debit_card",
      },
      "scheduled",
    );
    return { ...record, charge };
  }

  /** Submission time reached — calls the provider. Mirrors AchPaymentService.submitScheduledPayment. */
  async submitScheduledPayment(paymentAttemptId: string, actingUserId: string): Promise<PaymentAttemptRecord> {
    return this.deps.payments.submitPending(paymentAttemptId, actingUserId);
  }

  /**
   * A debtor- or staff-initiated ad-hoc payment (this sprint's "initial payment" and "recurring
   * payment" categories both go through this — recurring is simply this method called again for a
   * later installment, same as ACH's manual-payment precedent). Still requires an active,
   * unexpired card; still goes through the same verification/idempotency gate.
   */
  /**
   * `installmentScheduleItemId` is optional, mirroring `AchPaymentService.createManualPayment`'s
   * Sprint 13 addition — omitted, this is a general ad-hoc payment; provided, it links the payment
   * to the installment it covers so a manual payment clearing a previously-failed installment can
   * cancel that installment's still-pending automatic retry.
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
  }): Promise<PaymentAttemptRecord & { charge: DebitCardChargeBreakdown }> {
    await this.requireActiveUnexpiredCard(input.agreementId);
    const charge = await this.computeChargeBreakdown(input.agreementId, input.amountMinorUnits);
    const scheduled = await this.deps.payments.schedulePayment(
      {
        idempotencyKey: input.idempotencyKey,
        payer: input.payer,
        recipient: input.recipient,
        amountMinorUnits: charge.totalChargeMinorUnits,
        currency: input.currency,
        agreementId: input.agreementId,
        actingUserId: input.actingUserId,
        installmentScheduleItemId: input.installmentScheduleItemId,
        paymentMethod: "debit_card",
      },
      "scheduled",
    );
    if (scheduled.status !== "scheduled") {
      // Idempotent replay of an already-submitted manual payment — nothing further to do.
      return { ...scheduled, charge };
    }
    const submitted = await this.deps.payments.submitPending(scheduled.id, input.actingUserId);
    return { ...submitted, charge };
  }

  private async requireActiveUnexpiredCard(agreementId: string): Promise<void> {
    const active = await this.deps.cards.getActiveCard(agreementId);
    if (!active) {
      throw new ValidationError("An active debit card is required before a payment can be scheduled for this agreement.");
    }
    if (this.deps.cards.isCardExpired(active)) {
      throw new ValidationError("This card has expired. Register a new card before scheduling a payment.");
    }
  }
}
