import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAchPaymentService } from "@/lib/ach/getAchPaymentService";
import { getDebitCardPaymentService } from "@/lib/debitCard/getDebitCardPaymentService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzlePaymentRetryRepository } from "./drizzlePaymentRetryRepository";
import { PaymentRetryService } from "./paymentRetryService";

let cached: PaymentRetryService | null = null;

export function getPaymentRetryService(): PaymentRetryService {
  if (!cached) {
    cached = new PaymentRetryService({
      retries: new DrizzlePaymentRetryRepository(),
      paymentAttempts: new DrizzlePaymentAttemptRepository(),
      initiators: {
        ach: getAchPaymentService(),
        debit_card: getDebitCardPaymentService(),
        // PRSprint 18: a manual_off_platform attempt is created directly as "succeeded" (see
        // paymentService.ts's recordManualOffPlatformPayment) — it never fails and is never eligible
        // for an automatic retry, so this initiator exists only for Record<PaymentMethod, ...>
        // exhaustiveness and should structurally never be invoked.
        manual_off_platform: {
          async createManualPayment() {
            throw new Error("A manual off-platform payment can never fail and is never eligible for an automatic retry.");
          },
        },
      },
      profileOwners: new DrizzleProfileOwnerReader(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
