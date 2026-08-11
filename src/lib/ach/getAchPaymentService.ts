import "server-only";
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
    });
  }
  return cached;
}
