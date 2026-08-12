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
      },
      profileOwners: new DrizzleProfileOwnerReader(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
