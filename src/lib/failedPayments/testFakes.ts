import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestAchServices } from "@/lib/ach/testFakes";
import { createTestDebitCardServices } from "@/lib/debitCard/testFakes";
import { createTestBalanceService, createTestLedgerService } from "@/lib/ledger/testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createTestPaymentWebhookService } from "@/lib/payments/testFakes";
import type { InstallmentStatusRepository } from "./installmentStatusRepository";
import { FailedPaymentWorkflowService } from "./failedPaymentWorkflowService";
import { PaymentRetryService } from "./paymentRetryService";
import type { PaymentRetryRecord, PaymentRetryRepository, PaymentRetryStatus } from "./paymentRetryService";
import { RescheduleRequestService } from "./rescheduleRequestService";
import type { AgreementPartiesReader, RescheduleRequestRecord, RescheduleRequestRepository } from "./rescheduleRequestService";

/** Test-only in-memory doubles for the Sprint 13 failed-payment workflow, mirroring every other module's testFakes.ts pattern in this codebase. */

export type InstallmentItemStatus = "scheduled" | "paid" | "past_due" | "waived";

export class InMemoryInstallmentStatusRepository implements InstallmentStatusRepository {
  statusById = new Map<string, InstallmentItemStatus>();
  private dueDateById = new Map<string, string>();

  /** Test-only helper (not part of InstallmentStatusRepository) — seeds an installment's starting due date/status. */
  seed(installmentScheduleItemId: string, dueDate: string, status: InstallmentItemStatus = "scheduled"): void {
    this.statusById.set(installmentScheduleItemId, status);
    this.dueDateById.set(installmentScheduleItemId, dueDate);
  }

  async markPastDue(installmentScheduleItemId: string): Promise<void> {
    this.statusById.set(installmentScheduleItemId, "past_due");
  }

  async markPaid(installmentScheduleItemId: string): Promise<void> {
    this.statusById.set(installmentScheduleItemId, "paid");
  }

  async findDueDate(installmentScheduleItemId: string): Promise<string | null> {
    return this.dueDateById.get(installmentScheduleItemId) ?? null;
  }

  async updateDueDate(installmentScheduleItemId: string, dueDate: string): Promise<void> {
    this.dueDateById.set(installmentScheduleItemId, dueDate);
  }
}

export class InMemoryPaymentRetryRepository implements PaymentRetryRepository {
  byId = new Map<string, PaymentRetryRecord>();

  async insert(input: {
    originalPaymentAttemptId: string;
    installmentScheduleItemId: string;
    agreementId: string;
    scheduledFor: Date;
  }): Promise<PaymentRetryRecord> {
    const record: PaymentRetryRecord = {
      id: randomUUID(),
      status: "scheduled",
      resultingPaymentAttemptId: null,
      firedAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByOriginalPaymentAttemptId(originalPaymentAttemptId: string): Promise<PaymentRetryRecord | null> {
    return [...this.byId.values()].find((r) => r.originalPaymentAttemptId === originalPaymentAttemptId) ?? null;
  }

  async findByResultingPaymentAttemptId(resultingPaymentAttemptId: string): Promise<PaymentRetryRecord | null> {
    return [...this.byId.values()].find((r) => r.resultingPaymentAttemptId === resultingPaymentAttemptId) ?? null;
  }

  async findScheduledForInstallment(installmentScheduleItemId: string): Promise<PaymentRetryRecord | null> {
    return (
      [...this.byId.values()].find((r) => r.installmentScheduleItemId === installmentScheduleItemId && r.status === "scheduled") ?? null
    );
  }

  async findDueForFiring(now: Date): Promise<PaymentRetryRecord[]> {
    return [...this.byId.values()].filter((r) => r.status === "scheduled" && r.scheduledFor.getTime() <= now.getTime());
  }

  private mustFind(id: string): PaymentRetryRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_retry not found");
    return record;
  }

  async markFired(id: string, resultingPaymentAttemptId: string, firedAt: Date): Promise<PaymentRetryRecord> {
    const record = this.mustFind(id);
    record.status = "fired" satisfies PaymentRetryStatus;
    record.resultingPaymentAttemptId = resultingPaymentAttemptId;
    record.firedAt = firedAt;
    return record;
  }

  async markCanceled(id: string, canceledAt: Date, canceledReason: string): Promise<PaymentRetryRecord> {
    const record = this.mustFind(id);
    record.status = "canceled" satisfies PaymentRetryStatus;
    record.canceledAt = canceledAt;
    record.canceledReason = canceledReason;
    return record;
  }
}

export class InMemoryRescheduleRequestRepository implements RescheduleRequestRepository {
  byId = new Map<string, RescheduleRequestRecord>();

  async insert(input: {
    installmentScheduleItemId: string;
    agreementId: string;
    requestedByProfileKind: "personal" | "business";
    requestedByProfileId: string;
    currentDueDate: string;
    requestedDueDate: string;
    reason: string | null;
  }): Promise<RescheduleRequestRecord> {
    const record: RescheduleRequestRecord = {
      id: randomUUID(),
      status: "pending",
      decidedByUserId: null,
      decidedAt: null,
      decisionReason: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<RescheduleRequestRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async decide(
    id: string,
    status: "approved" | "rejected",
    decidedByUserId: string,
    decidedAt: Date,
    decisionReason: string | null,
  ): Promise<RescheduleRequestRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("reschedule_request not found");
    record.status = status;
    record.decidedByUserId = decidedByUserId;
    record.decidedAt = decidedAt;
    record.decisionReason = decisionReason;
    return record;
  }
}

type AgreementPartiesFixture = { creditor: { profileKind: "personal" | "business"; profileId: string }; debtor: { profileKind: "personal" | "business"; profileId: string } };

export class InMemoryAgreementPartiesReader implements AgreementPartiesReader {
  private byAgreementId = new Map<string, AgreementPartiesFixture>();

  set(agreementId: string, parties: AgreementPartiesFixture): void {
    this.byAgreementId.set(agreementId, parties);
  }

  async getParties(agreementId: string): Promise<AgreementPartiesFixture | null> {
    return this.byAgreementId.get(agreementId) ?? null;
  }
}

class InMemoryAuditEventRepositoryForFailedPayments implements AuditEventRepository {
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
 * Full Sprint 13 test context, built around ACH sharing one `PaymentService`/verification/
 * profile-owner instance set, exactly as production does — which method is used doesn't matter to
 * this sprint's own orchestration logic. A separate, independent debit-card context is wired in only
 * to satisfy `PaymentRetryService`'s `initiators` map type; it is exercised only by
 * `paymentRetryService.test.ts`'s dedicated "routes by payment method" case, never by the shared ACH
 * fixtures every other test in this sprint uses.
 */
export function createTestFailedPaymentWorkflow(delayBusinessDays?: number) {
  const ach = createTestAchServices();
  const card = createTestDebitCardServices();
  const ledgerCtx = createTestLedgerService();
  const balanceCtx = createTestBalanceService(ledgerCtx);
  const notifyCtx = createTestNotificationService();
  const installments = new InMemoryInstallmentStatusRepository();
  const retries = new InMemoryPaymentRetryRepository();
  const rescheduleRequests = new InMemoryRescheduleRequestRepository();
  const agreementParties = new InMemoryAgreementPartiesReader();
  const auditRepo = new InMemoryAuditEventRepositoryForFailedPayments();

  const rescheduleRequestService = new RescheduleRequestService({
    requests: rescheduleRequests,
    installments,
    parties: agreementParties,
    profileOwners: ach.paymentCtx.verificationCtx.profileOwners,
    audit: new AuditService(auditRepo),
  });

  const paymentRetryService = new PaymentRetryService({
    retries,
    paymentAttempts: ach.paymentCtx.payments,
    initiators: { ach: ach.achPaymentService, debit_card: card.debitCardPaymentService },
    profileOwners: ach.paymentCtx.verificationCtx.profileOwners,
    audit: new AuditService(auditRepo),
    delayBusinessDays,
  });

  const failedPaymentWorkflowService = new FailedPaymentWorkflowService({
    installments,
    retries: paymentRetryService,
    notifications: notifyCtx.notificationService,
    profileOwners: ach.paymentCtx.verificationCtx.profileOwners,
  });

  const webhookCtx = createTestPaymentWebhookService(ach.paymentCtx, ledgerCtx, failedPaymentWorkflowService);

  return {
    ach,
    card,
    ledgerCtx,
    balanceCtx,
    notifyCtx,
    installments,
    retries,
    rescheduleRequests,
    agreementParties,
    rescheduleRequestService,
    auditRepo,
    paymentRetryService,
    failedPaymentWorkflowService,
    webhookCtx,
  };
}
