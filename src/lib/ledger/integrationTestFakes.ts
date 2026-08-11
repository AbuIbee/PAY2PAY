import { createTestPaymentService, createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import { ReconciliationService } from "./reconciliationService";
import { createTestBalanceService, createTestLedgerService, InMemoryReconciliationExceptionRepository } from "./testFakes";

/**
 * Sprint 10 full-pipeline test context: PaymentService + PaymentWebhookService + LedgerService +
 * BalanceService + ReconciliationService, all sharing the same underlying in-memory repositories,
 * exactly as production wires them. Lives in its own file (not payments/testFakes.ts or
 * ledger/testFakes.ts) specifically to avoid a circular import between those two files — this file
 * imports from both, one-directionally.
 */
export function createFullLedgerTestContext() {
  const ledgerCtx = createTestLedgerService();
  const paymentCtx = createTestPaymentService();
  const webhookCtx = createTestPaymentWebhookService(paymentCtx, ledgerCtx);
  const balanceCtx = createTestBalanceService(ledgerCtx);
  const exceptions = new InMemoryReconciliationExceptionRepository();
  const reconciliationService = new ReconciliationService({
    payments: paymentCtx.payments,
    webhookEvents: webhookCtx.events,
    provider: paymentCtx.provider,
    ledger: ledgerCtx.ledgerService,
    exceptions,
  });
  return { ledgerCtx, paymentCtx, webhookCtx, balanceCtx, exceptions, reconciliationService };
}
