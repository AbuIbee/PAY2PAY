import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryAgreementRepository } from "@/lib/agreements/testFakes";
import { createTestPaymentService, createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import { AgreementCompletionService } from "./agreementCompletionService";
import { ReconciliationService } from "./reconciliationService";
import { createTestBalanceService, createTestLedgerService, InMemoryReconciliationExceptionRepository } from "./testFakes";

class InMemoryAuditEventRepositoryForCompletion implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

/**
 * Sprint 10 full-pipeline test context: PaymentService + PaymentWebhookService + LedgerService +
 * BalanceService + ReconciliationService, all sharing the same underlying in-memory repositories,
 * exactly as production wires them. Lives in its own file (not payments/testFakes.ts or
 * ledger/testFakes.ts) specifically to avoid a circular import between those two files — this file
 * imports from both, one-directionally.
 *
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md)
 * addition: also wires `AgreementCompletionService` (`completionCtx`) and a real
 * `InMemoryAgreementRepository` (`agreementRepo`) into both `paymentCtx.paymentService` (so
 * `recordManualOffPlatformPayment`'s overpayment check and completion trigger are live) and
 * `webhookCtx.paymentWebhookService` (so a provider-routed `payment.succeeded` webhook's completion
 * check is live too) — exactly as production wires them (see getPaymentService.ts/
 * getPaymentWebhookService.ts). Every pre-PRSprint-18 test using this context is unaffected: an
 * agreement that's never seeded into `agreementRepo` simply makes `checkAndAdvance` a no-op
 * (`findById` returns null), matching the pre-existing "agreementId as opaque grouping label" test
 * convention this context has always allowed.
 */
export function createFullLedgerTestContext() {
  const ledgerCtx = createTestLedgerService();
  const balanceCtx = createTestBalanceService(ledgerCtx);
  const agreementRepo = new InMemoryAgreementRepository();
  const completionAuditRepo = new InMemoryAuditEventRepositoryForCompletion();
  const completionService = new AgreementCompletionService({
    agreements: agreementRepo,
    balances: balanceCtx.balanceService,
    audit: new AuditService(completionAuditRepo),
  });
  const paymentCtx = createTestPaymentService({
    balances: balanceCtx.balanceService,
    ledger: ledgerCtx.ledgerService,
    completion: completionService,
  });
  const webhookCtx = createTestPaymentWebhookService(paymentCtx, ledgerCtx, undefined, undefined, undefined, completionService);
  const exceptions = new InMemoryReconciliationExceptionRepository();
  const reconciliationService = new ReconciliationService({
    payments: paymentCtx.payments,
    webhookEvents: webhookCtx.events,
    provider: paymentCtx.provider,
    ledger: ledgerCtx.ledgerService,
    exceptions,
  });
  return { ledgerCtx, paymentCtx, webhookCtx, balanceCtx, exceptions, reconciliationService, agreementRepo, completionService };
}
