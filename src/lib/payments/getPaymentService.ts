import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAgreementCompletionService } from "@/lib/ledger/getAgreementCompletionService";
import { getBalanceService } from "@/lib/ledger/getBalanceService";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { DrizzleAgreementPartiesReader } from "./drizzleAgreementPartiesReader";
import { DrizzleAtomicManualPaymentPoster } from "./drizzleAtomicManualPaymentPoster";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { getPaymentProvider } from "./getPaymentProvider";
import { PaymentService } from "./paymentService";

let cached: PaymentService | null = null;

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md) note:
 * `balances`/`ledger`/`completion` are wired here so the overpayment policy and agreement-completion
 * check are always live in production, even though they're optional on `PaymentServiceDeps` (most
 * existing tests omit them — see AgreementBalanceReader's doc comment). `installmentHook` (marking
 * the specific installment paid for a manual payment) is deliberately NOT wired here: doing so would
 * require importing `getFailedPaymentWorkflowService`, which transitively imports
 * `getAchPaymentService`/`getDebitCardPaymentService` — both of which already import THIS file's
 * `getPaymentService`, which would make this a real circular module-import graph rather than the safe,
 * lazy-only-at-call-time kind. Balance correctness is unaffected either way (BalanceService derives
 * entirely from the ledger, never from installment_schedule_item.status) — see the PRSprint 18
 * completion report's "known limitations" section.
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
      notifications: getNotificationService(),
    });
  }
  return cached;
}
