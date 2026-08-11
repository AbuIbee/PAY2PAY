import "server-only";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "@/lib/payments/drizzlePaymentWebhookEventRepository";
import { DrizzleReconciliationExceptionRepository } from "./drizzleReconciliationExceptionRepository";
import { getLedgerService } from "./getLedgerService";
import { ReconciliationService } from "./reconciliationService";

let cached: ReconciliationService | null = null;

export function getReconciliationService(): ReconciliationService {
  if (!cached) {
    cached = new ReconciliationService({
      payments: new DrizzlePaymentAttemptRepository(),
      webhookEvents: new DrizzlePaymentWebhookEventRepository(),
      provider: getPaymentProvider(),
      ledger: getLedgerService(),
      exceptions: new DrizzleReconciliationExceptionRepository(),
    });
  }
  return cached;
}
