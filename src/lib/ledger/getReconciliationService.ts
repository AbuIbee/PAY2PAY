import "server-only";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "@/lib/payments/drizzlePaymentWebhookEventRepository";
import { getPlatformFeePolicy } from "@/lib/payments/getPlatformFeePolicy";
import { getAgreementCompletionService } from "./getAgreementCompletionService";
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
      // R09 addition: opportunistic, idempotent lifecycle-convergence retry — see ReconciliationService's own doc comment.
      completion: getAgreementCompletionService(),
      // PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 5): the SAME centralized platform-fee
      // authority every other financial-effect path uses — see ReconciliationService's own doc comment.
      platformFeePolicy: getPlatformFeePolicy(),
    });
  }
  return cached;
}
