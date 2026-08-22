import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getFailedPaymentWorkflowService } from "@/lib/failedPayments/getFailedPaymentWorkflowService";
import { getAgreementCompletionService } from "@/lib/ledger/getAgreementCompletionService";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getRiskEventService } from "@/lib/risk/getRiskEventService";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "./drizzlePaymentWebhookEventRepository";
import { getPaymentProvider } from "./getPaymentProvider";
import { PaymentWebhookService } from "./paymentWebhookService";

let cached: PaymentWebhookService | null = null;

export function getPaymentWebhookService(): PaymentWebhookService {
  if (!cached) {
    cached = new PaymentWebhookService({
      provider: getPaymentProvider(),
      events: new DrizzlePaymentWebhookEventRepository(),
      payments: new DrizzlePaymentAttemptRepository(),
      ledger: getLedgerService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      failedPaymentWorkflow: getFailedPaymentWorkflowService(),
      notifications: getNotificationService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      completion: getAgreementCompletionService(),
      riskEvents: getRiskEventService(),
    });
  }
  return cached;
}
