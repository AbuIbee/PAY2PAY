import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryAgreementRepository } from "@/lib/agreements/testFakes";
import { KeyedMutex } from "@/lib/concurrency/keyedMutex";
import { ValidationError } from "@/lib/errors";
import { createTestPaymentService, createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import type { AtomicManualPaymentPoster, PaymentAttemptRecord } from "@/lib/payments/paymentService";
import { AgreementCompletionService } from "./agreementCompletionService";
import { reconstructPaidAndReversed } from "./balanceService";
import { ReconciliationService } from "./reconciliationService";
import type { LedgerAccountRepository, LedgerJournalEntryRepository } from "./ledgerService";
import { createTestBalanceService, createTestLedgerService, InMemoryAgreementTermsReader, InMemoryReconciliationExceptionRepository } from "./testFakes";

/**
 * PRSprint 20 (docs/prsprints/PRSPRINT_20_IDEMPOTENCY_CONCURRENCY_FINANCIAL_STATE_SAFETY.md): the
 * in-memory counterpart to `DrizzleAtomicManualPaymentPoster` — see `AtomicManualPaymentPoster`'s doc
 * comment in paymentService.ts for the race it closes. Uses `KeyedMutex` (a real, in-process async
 * lock) rather than the real DB row lock the production implementation uses — see `KeyedMutex`'s own
 * doc comment for why that distinction matters and is fine specifically for a single-process test
 * fake. Genuinely serializes concurrent callers for the same agreementId, so a `Promise.all`-based
 * test against this fake proves the read-check-insert-post sequencing is correct, not merely that the
 * fake happened not to race.
 */
class InMemoryAtomicManualPaymentPoster implements AtomicManualPaymentPoster {
  private mutex = new KeyedMutex();
  // Settable after construction (not passed into the constructor) because of this context's
  // construction order: `createTestPaymentService` is what creates the `payments` repository this
  // poster needs, and the poster itself must already exist to be passed *into*
  // `createTestPaymentService`'s options — see createFullLedgerTestContext below.
  payments!: ReturnType<typeof createTestPaymentService>["payments"];

  constructor(
    private readonly deps: {
      ledgerAccounts: LedgerAccountRepository;
      ledgerEntries: LedgerJournalEntryRepository;
      terms: InMemoryAgreementTermsReader;
    },
  ) {}

  async postManualPaymentAtomically(input: Parameters<AtomicManualPaymentPoster["postManualPaymentAtomically"]>[0]): Promise<PaymentAttemptRecord> {
    return this.mutex.withLock(input.agreementId, async () => {
      const termsInfo = await this.deps.terms.getPrincipal(input.agreementId);
      if (!termsInfo) throw new ValidationError("Agreement not found, or has no signed terms to compute a balance against yet.");
      const entries = await this.deps.ledgerEntries.listForAgreement(input.agreementId);
      const { amountPaidMinorUnits } = reconstructPaidAndReversed(entries);
      const remainingBalanceMinorUnits = termsInfo.principalMinorUnits - amountPaidMinorUnits;
      if (input.amountMinorUnits > remainingBalanceMinorUnits) {
        throw new ValidationError(
          `This payment of ${input.amountMinorUnits} minor units would exceed the agreement's remaining balance of ${remainingBalanceMinorUnits} minor units. Overpayment is not permitted.`,
        );
      }

      const record = await this.payments.insertPending({
        idempotencyKey: input.idempotencyKey,
        payerProfileKind: input.payerProfileKind,
        payerProfileId: input.payerProfileId,
        recipientProfileKind: input.recipientProfileKind,
        recipientProfileId: input.recipientProfileId,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        agreementId: input.agreementId,
        providerName: "manual",
        initialStatus: "succeeded",
        paymentMethod: "manual_off_platform",
        recordedByUserId: input.recordedByUserId,
      });
      const processorClearing = await this.deps.ledgerAccounts.findOrCreate("processor_clearing", input.agreementId);
      const creditorPayable = await this.deps.ledgerAccounts.findOrCreate("creditor_proceeds_payable", input.agreementId);
      await this.deps.ledgerEntries.insert({
        entryType: "payment_cleared",
        agreementId: input.agreementId,
        paymentAttemptId: record.id,
        currency: input.currency,
        reason: null,
        postings: [
          { accountId: processorClearing.id, accountType: "processor_clearing", direction: "debit", amountMinorUnits: input.amountMinorUnits },
          { accountId: creditorPayable.id, accountType: "creditor_proceeds_payable", direction: "credit", amountMinorUnits: input.amountMinorUnits },
        ],
      });
      return record;
    });
  }
}

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
  const atomicManualPayments = new InMemoryAtomicManualPaymentPoster({
    ledgerAccounts: ledgerCtx.accounts,
    ledgerEntries: ledgerCtx.entries,
    terms: balanceCtx.terms,
  });
  const paymentCtx = createTestPaymentService({
    balances: balanceCtx.balanceService,
    ledger: ledgerCtx.ledgerService,
    completion: completionService,
    atomicManualPayments,
  });
  atomicManualPayments.payments = paymentCtx.payments;
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
