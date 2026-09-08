import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
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
    );
  }
  return cached;
}
