import "server-only";
import { getServerEnv } from "@/config/env";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import { DebitCardPaymentService } from "./debitCardPaymentService";
import { DrizzleAgreementFeeAllocationReader } from "./drizzleAgreementFeeAllocationReader";
import { getDebitCardMethodService } from "./getDebitCardMethodService";

let cached: DebitCardPaymentService | null = null;

export function getDebitCardPaymentService(): DebitCardPaymentService {
  if (!cached) {
    cached = new DebitCardPaymentService({
      cards: getDebitCardMethodService(),
      payments: getPaymentService(),
      paymentAttempts: new DrizzlePaymentAttemptRepository(),
      feeAllocation: new DrizzleAgreementFeeAllocationReader(),
      // PAID2YOU — B0-D C2 (payment activation gate): see DebitCardPaymentService.submitScheduledPayment's own doc comment.
      newPaymentInitiationVerified: getServerEnv().ADYEN_PAYMENTS_VERIFIED,
    });
  }
  return cached;
}
