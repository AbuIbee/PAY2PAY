import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getFailedPaymentWorkflowService } from "@/lib/failedPayments/getFailedPaymentWorkflowService";
import { getAgreementCompletionService } from "@/lib/ledger/getAgreementCompletionService";
import { DrizzleReconciliationExceptionRepository } from "@/lib/ledger/drizzleReconciliationExceptionRepository";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getRiskEventService } from "@/lib/risk/getRiskEventService";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "./drizzlePaymentWebhookEventRepository";
import { getPaymentProvider } from "./getPaymentProvider";
import { getPlatformFeePolicy } from "./getPlatformFeePolicy";
import { DrizzlePaymentTransitionCoordinator } from "./paymentTransitionCoordinator";
import { PaymentWebhookService } from "./paymentWebhookService";

let cached: PaymentWebhookService | null = null;

export function getPaymentWebhookService(): PaymentWebhookService {
  if (!cached) {
    cached = new PaymentWebhookService({
      provider: getPaymentProvider(),
      events: new DrizzlePaymentWebhookEventRepository(),
      payments: new DrizzlePaymentAttemptRepository(),
      transitionCoordinator: new DrizzlePaymentTransitionCoordinator(),
      ledger: getLedgerService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      failedPaymentWorkflow: getFailedPaymentWorkflowService(),
      notifications: getNotificationService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      completion: getAgreementCompletionService(),
      riskEvents: getRiskEventService(),
      // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1): automatic conflict
      // detection during normal event processing — see `ConflictExceptionRecorder`'s own doc comment.
      conflictExceptions: new DrizzleReconciliationExceptionRepository(),
      // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 2): the SAME shared
      // singleton `resolveAmbiguousRetry` also uses — see `getPlatformFeePolicy`'s own doc comment.
      platformFeePolicy: getPlatformFeePolicy(),
    });
  }
  return cached;
}
