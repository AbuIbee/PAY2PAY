import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getFailedPaymentWorkflowService } from "@/lib/failedPayments/getFailedPaymentWorkflowService";
import { getAgreementCompletionService } from "@/lib/ledger/getAgreementCompletionService";
import { getBalanceService } from "@/lib/ledger/getBalanceService";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { DrizzleAgreementPartiesReader } from "./drizzleAgreementPartiesReader";
import { DrizzleAgreementScheduleReader } from "./drizzleAgreementScheduleReader";
import { DrizzleAtomicManualPaymentPoster } from "./drizzleAtomicManualPaymentPoster";
import { DrizzleInstallmentAwarePaymentReserver } from "./drizzleInstallmentAwarePaymentReserver";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { DrizzleSettlementContextVerifier } from "./drizzleSettlementContextVerifier";
import { getPaymentProvider } from "./getPaymentProvider";
import { PaymentService } from "./paymentService";

let cached: PaymentService | null = null;

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md) note:
 * `balances`/`ledger`/`completion` are wired here so the overpayment policy and agreement-completion
 * check are always live in production, even though they're optional on `PaymentServiceDeps` (most
 * existing tests omit them — see AgreementBalanceReader's doc comment).
 *
 * R11 PASS B1 (Defect B1-2 — MANUAL/OFF-PLATFORM PAYMENT DOES NOT RUN INSTALLMENT COMPLETION):
 * `installmentHook` (marking the specific installment paid for a manual payment, and canceling any
 * now-superfluous pending retry — see `ManualPaymentInstallmentHook`'s own doc comment) was previously
 * left unwired entirely: a manual payment could post real `payment_cleared` ledger truth and even
 * satisfy an installment or advance agreement completion, while `installment_schedule_item.status`
 * stayed stale forever and a still-pending retry for that same installment was never canceled. Fixed
 * with a LAZY THUNK — `getFailedPaymentWorkflowService()` is called only when `handlePaymentSucceeded`
 * is actually INVOKED (inside `recordManualOffPlatformPayment`, well after this factory's own `cached`
 * has already been assigned), never at this module's own construction time. This is the SAME pattern
 * `getPaymentRetryService.ts` already uses for its own `effectApplier` dependency, for the identical
 * reason: `getFailedPaymentWorkflowService` -> `getPaymentRetryService` ->
 * `getAchPaymentService`/`getDebitCardPaymentService` -> THIS file's `getPaymentService` is a real
 * circular import graph — safe for two modules that only ever export FUNCTIONS (never top-level
 * values evaluated eagerly), but calling through it EAGERLY, before this factory's own `cached` is
 * set, would re-enter `getPaymentService()` while it is still under construction and recurse forever
 * — exactly the class of bug `getPaymentRetryService.ts`'s own doc comment documents for
 * `getPaymentWebhookService()`. `FailedPaymentWorkflowService.handlePaymentSucceeded` itself reuses
 * the EXACT SAME `FailedPaymentRetryCoordinator.coordinateSuccess` the provider-routed webhook success
 * path already calls — never a second, duplicated amount-aware-satisfaction/retry-cancellation
 * implementation. Never duplicates the ledger entry (this hook only ever marks installment status/
 * cancels retries, it posts no ledger entries of its own) and never double-runs agreement completion
 * (`completion.checkAndAdvance` remains the SOLE agreement-lifecycle call, unchanged, immediately
 * after this hook, exactly as before).
 */
export function getPaymentService(): PaymentService {
  if (!cached) {
    cached = new PaymentService({
      provider: getPaymentProvider(),
      verification: getVerificationService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      payments: new DrizzlePaymentAttemptRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      agreements: new DrizzleAgreementPartiesReader(),
      balances: getBalanceService(),
      ledger: getLedgerService(),
      completion: getAgreementCompletionService(),
      atomicManualPayments: new DrizzleAtomicManualPaymentPoster(),
      installmentReserver: new DrizzleInstallmentAwarePaymentReserver(),
      scheduleReader: new DrizzleAgreementScheduleReader(),
      settlementContext: new DrizzleSettlementContextVerifier(),
      notifications: getNotificationService(),
      installmentHook: {
        handlePaymentSucceeded: (payment) => getFailedPaymentWorkflowService().handlePaymentSucceeded(payment),
      },
    });
  }
  return cached;
}
