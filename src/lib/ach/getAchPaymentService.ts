import "server-only";
import { getServerEnv } from "@/config/env";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import { AchPaymentService } from "./achPaymentService";
import { getAchMandateService } from "./getAchMandateService";

let cached: AchPaymentService | null = null;

export function getAchPaymentService(): AchPaymentService {
  if (!cached) {
    cached = new AchPaymentService({
      mandates: getAchMandateService(),
      payments: getPaymentService(),
      paymentAttempts: new DrizzlePaymentAttemptRepository(),
      // PAID2YOU — B0-D C2 (payment activation gate): see AchPaymentService.submitScheduledPayment's own doc comment.
      newPaymentInitiationVerified: getServerEnv().ADYEN_PAYMENTS_VERIFIED,
    });
  }
  return cached;
}
