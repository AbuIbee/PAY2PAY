import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getPartialPaymentAutoApplicationService } from "@/lib/partialPayments/getPartialPaymentAutoApplicationService";
import { DrizzleAchMandateProviderRefReader } from "@/lib/payments/drizzleAchMandateProviderRefReader";
import { getPlatformFeePolicy } from "@/lib/payments/getPlatformFeePolicy";
import { DEFAULT_RETRY_DELAY_BUSINESS_DAYS } from "./paymentRetryService";
import { DrizzleFailedPaymentRetryCoordinator, type FailedPaymentRetryCoordinator } from "./failedPaymentRetryCoordinator";

let cached: FailedPaymentRetryCoordinator | null = null;

/** Shared by both `getFailedPaymentWorkflowService` and `getPaymentRetryService` — the failure/success/execution-claim sides of the SAME installment-locking protocol must reason about the same coordinator contract, though each call always opens its own DB transaction regardless. */
export function getFailedPaymentRetryCoordinator(): FailedPaymentRetryCoordinator {
  if (!cached) {
    cached = new DrizzleFailedPaymentRetryCoordinator(
      undefined,
      DEFAULT_RETRY_DELAY_BUSINESS_DAYS,
      new AuditService(new DrizzleAuditEventRepository()),
      undefined,
      // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 2): the SAME shared
      // singleton `PaymentWebhookService`'s own normal webhook-receipt ledger posting uses — see
      // `getPlatformFeePolicy`'s own doc comment.
      getPlatformFeePolicy(),
      // R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 1B): see
      // `DrizzleFailedPaymentRetryCoordinator.repairLegacyLineageAndApply`'s own doc comment.
      getPartialPaymentAutoApplicationService(),
      // PAID2YOU — B0-D ADYEN PHASE 1A (blocker 1 — exact payment method): the SAME resolver
      // `getPaymentService.ts` uses — see `DrizzleAchMandateProviderRefReader`'s own doc comment.
      new DrizzleAchMandateProviderRefReader(),
      // PAID2YOU — B0-D C2 FINAL SECURITY GATE: the real production value, explicitly wired — see
      // `DrizzleFailedPaymentRetryCoordinator`'s own doc comment on this field for why its default
      // (`true`) is never relied on here.
      getServerEnv().ADYEN_PAYMENTS_VERIFIED,
    );
  }
  return cached;
}
