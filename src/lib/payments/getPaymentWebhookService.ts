import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getFailedPaymentWorkflowService } from "@/lib/failedPayments/getFailedPaymentWorkflowService";
import { getAgreementCompletionService } from "@/lib/ledger/getAgreementCompletionService";
import { DrizzleReconciliationExceptionRepository } from "@/lib/ledger/drizzleReconciliationExceptionRepository";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { getPartialPaymentAutoApplicationService } from "@/lib/partialPayments/getPartialPaymentAutoApplicationService";
import { getPayoutService } from "@/lib/payouts/getPayoutService";
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
      // STAGE 3 G01-G12 (docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md):
      // lazy dependency-access boundary — `getPaymentProvider()` is resolved only when a
      // provider-dependent operation (`receiveWebhook`) actually reads this property, never merely
      // because this singleton is constructed. `recoverBatch`/`receiveInternalEvent`/`applyEvent`
      // never touch `this.deps.provider` at all, so an unregistered provider must not block them.
      get provider() {
        return getPaymentProvider();
      },
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
      // R11 PASS B1 — FINAL TARGETED CORRECTION (Defect 1): the missing production integration point
      // — see PartialPaymentAutoApplicationService's own doc comment.
      partialPaymentApplication: getPartialPaymentAutoApplicationService(),
      // PAID2YOU — V3 BANK-MANAGED-PAYMENTS ARCHITECTURE (security transfer, SC-05 — eliminate
      // fictional payouts): see `recordPayoutOwedRequired`'s own doc comment — this is the ONLY thing
      // `PaymentWebhookService` ever calls on `PayoutService`.
      payouts: getPayoutService(),
    });
  }
  return cached;
}
