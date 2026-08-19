import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestLedgerService } from "@/lib/ledger/testFakes";
import type { NotificationService } from "@/lib/notify/notificationService";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import { PaymentService } from "./paymentService";
import type {
  AgreementBalanceReader,
  AgreementCompletionChecker,
  AgreementPartiesReader,
  AtomicManualPaymentPoster,
  LedgerPoster,
  ManualPaymentInstallmentHook,
  PaymentAttemptRecord,
  PaymentAttemptRepository,
  PaymentAttemptStatus,
  PaymentMethod,
} from "./paymentService";
import type { ProfileRef } from "./paymentProvider";
import { PaymentWebhookService } from "./paymentWebhookService";
import type { FailedPaymentWorkflow, PaymentWebhookEventRecord, PaymentWebhookEventRepository } from "./paymentWebhookService";
import { SandboxPaymentProvider } from "./sandboxPaymentProvider";

/** Test-only in-memory doubles for PaymentService, mirroring src/lib/csvImport/testFakes.ts's pattern. */

export class InMemoryPaymentAttemptRepository implements PaymentAttemptRepository {
  private byId = new Map<string, PaymentAttemptRecord>();
  private idempotencyKeys = new Set<string>();

  async insertPending(input: {
    idempotencyKey: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    recipientProfileKind: "personal" | "business";
    recipientProfileId: string;
    amountMinorUnits: number;
    currency: string;
    agreementId: string | null;
    providerName: string;
    installmentScheduleItemId?: string | null;
    initialStatus?: PaymentAttemptStatus;
    paymentMethod?: PaymentMethod | null;
    recordedByUserId?: string | null;
    bankConnectionId?: string | null;
  }): Promise<PaymentAttemptRecord> {
    if (this.idempotencyKeys.has(input.idempotencyKey)) {
      throw new Error("duplicate idempotency key");
    }
    this.idempotencyKeys.add(input.idempotencyKey);
    const now = new Date();
    const { initialStatus, installmentScheduleItemId, paymentMethod, recordedByUserId, bankConnectionId, ...rest } = input;
    const record: PaymentAttemptRecord = {
      id: randomUUID(),
      status: initialStatus ?? "pending",
      providerPaymentId: null,
      failureReason: null,
      payoutCompletedAt: null,
      payoutInitiatedAt: null,
      installmentScheduleItemId: installmentScheduleItemId ?? null,
      paymentMethod: paymentMethod ?? null,
      recordedByUserId: recordedByUserId ?? null,
      recipientConfirmedAt: null,
      bankConnectionId: bankConnectionId ?? null,
      createdAt: now,
      updatedAt: now,
      ...rest,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async updateStatus(
    id: string,
    status: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
  ): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.status = status;
    if (fields.providerPaymentId !== undefined) record.providerPaymentId = fields.providerPaymentId;
    if (fields.failureReason !== undefined) record.failureReason = fields.failureReason;
    record.updatedAt = new Date();
    return record;
  }

  async confirmManualPayment(id: string, confirmedAt: Date): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.recipientConfirmedAt = confirmedAt;
    record.updatedAt = new Date();
    return record;
  }

  async findById(id: string): Promise<PaymentAttemptRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PaymentAttemptRecord | null> {
    return [...this.byId.values()].find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<PaymentAttemptRecord | null> {
    return [...this.byId.values()].find((r) => r.providerPaymentId === providerPaymentId) ?? null;
  }

  async markPayoutCompleted(id: string, payoutCompletedAt: Date): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.payoutCompletedAt = payoutCompletedAt;
    record.updatedAt = new Date();
    return record;
  }

  async markPayoutInitiated(id: string, payoutInitiatedAt: Date): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.payoutInitiatedAt = payoutInitiatedAt;
    record.updatedAt = new Date();
    return record;
  }

  async findOpenByInstallment(installmentScheduleItemId: string): Promise<PaymentAttemptRecord | null> {
    const openStatuses: PaymentAttemptStatus[] = ["pending", "scheduled", "submitted", "processing"];
    return (
      [...this.byId.values()].find(
        (r) => r.installmentScheduleItemId === installmentScheduleItemId && openStatuses.includes(r.status),
      ) ?? null
    );
  }

  async listAll(): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()];
  }

  async listByAgreementId(agreementId: string): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.agreementId === agreementId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Test-only helper (not part of PaymentAttemptRepository) — backdates a record for staleness tests. */
  setCreatedAt(id: string, createdAt: Date): void {
    const record = this.byId.get(id);
    if (record) record.createdAt = createdAt;
  }
}

/**
 * PRSprint 09: default-permissive fake — an unregistered `agreementId` resolves to `null` (no
 * agreement found), which `PaymentService.reserveAttempt` treats as "nothing to cross-check", not
 * "reject". Matches this test suite's long-established convention (predating this PRSprint) of
 * using `agreementId` as an opaque grouping label in many fixtures with no backing agreement row —
 * every pre-PRSprint-09 test that never calls `.register()` is unaffected. Tests that specifically
 * exercise the new payer/recipient-vs-agreement cross-check call `.register()` first.
 */
export class InMemoryAgreementPartiesReader implements AgreementPartiesReader {
  private parties = new Map<string, { creditor: ProfileRef; debtor: ProfileRef }>();

  register(agreementId: string, parties: { creditor: ProfileRef; debtor: ProfileRef }): void {
    this.parties.set(agreementId, parties);
  }

  async getParties(agreementId: string): Promise<{ creditor: ProfileRef; debtor: ProfileRef } | null> {
    return this.parties.get(agreementId) ?? null;
  }
}

class InMemoryAuditEventRepositoryForPayments implements AuditEventRepository {
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

const TEST_WEBHOOK_SECRET = "test-sandbox-payment-webhook-secret";

/**
 * Builds a full PaymentService test context sharing the same underlying VerificationService/
 * profileOwners instances, exactly as production does. PRSprint 18: `balances`/`ledger`/`completion`/
 * `installmentHook` are optional — every pre-PRSprint-18 call site omitting them is unaffected (the
 * overpayment check and completion/manual-payment features simply don't run); pass them (e.g. from
 * `createFullLedgerTestContext`) to exercise those PRSprint 18 behaviors.
 */
export function createTestPaymentService(options?: {
  balances?: AgreementBalanceReader;
  ledger?: LedgerPoster;
  completion?: AgreementCompletionChecker;
  installmentHook?: ManualPaymentInstallmentHook;
  /** PRSprint 20: optional — see AtomicManualPaymentPoster's own doc comment. */
  atomicManualPayments?: AtomicManualPaymentPoster;
}) {
  const verificationCtx = createTestVerificationService();
  const provider = new SandboxPaymentProvider(TEST_WEBHOOK_SECRET);
  const payments = new InMemoryPaymentAttemptRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPayments();
  const agreements = new InMemoryAgreementPartiesReader();

  const paymentService = new PaymentService({
    provider,
    verification: verificationCtx.verificationService,
    profileOwners: verificationCtx.profileOwners,
    payments,
    audit: new AuditService(auditRepo),
    agreements,
    balances: options?.balances,
    ledger: options?.ledger,
    completion: options?.completion,
    installmentHook: options?.installmentHook,
    atomicManualPayments: options?.atomicManualPayments,
  });

  return { verificationCtx, provider, payments, auditRepo, agreements, paymentService };
}

export class InMemoryPaymentWebhookEventRepository implements PaymentWebhookEventRepository {
  private byId = new Map<string, PaymentWebhookEventRecord>();
  // PRSprint 20 (docs/prsprints/PRSPRINT_20_IDEMPOTENCY_CONCURRENCY_FINANCIAL_STATE_SAFETY.md): a
  // synchronous, no-await-before-check-and-reserve index — the fake's own accurate model of what the
  // real DB's `(provider, provider_event_id)` unique index guarantees atomically. The prior
  // implementation re-checked via the async `findByProviderEvent` (an await point) before inserting,
  // which left a genuine race window a concurrent `Promise.all` test could fall through (both callers
  // pass the check before either reserves the key) — a window the real Postgres unique constraint
  // never has. This mirrors `InMemoryPaymentAttemptRepository.insertPending`'s own already-correct
  // synchronous-reservation pattern.
  private reservedKeys = new Set<string>();

  async findByProviderEvent(provider: string, providerEventId: string): Promise<PaymentWebhookEventRecord | null> {
    return [...this.byId.values()].find((e) => e.provider === provider && e.providerEventId === providerEventId) ?? null;
  }

  async insert(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<PaymentWebhookEventRecord> {
    const key = `${input.provider}:${input.providerEventId}`;
    if (this.reservedKeys.has(key)) throw new Error("duplicate webhook event");
    this.reservedKeys.add(key);
    const record: PaymentWebhookEventRecord = { id: randomUUID(), receivedAt: new Date(), processedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async markProcessed(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.processedAt = new Date();
  }

  async listAll(): Promise<PaymentWebhookEventRecord[]> {
    return [...this.byId.values()];
  }
}

/**
 * Builds a full PaymentWebhookService test context sharing the same provider/payments repo as an
 * existing PaymentService context (pass one in to correlate webhook events with payments already
 * created through it). Sprint 10: also wires a LedgerService test context — pass one in (e.g. to
 * inspect posted entries afterward) or a fresh one is created.
 */
export function createTestPaymentWebhookService(
  paymentCtx: ReturnType<typeof createTestPaymentService>,
  ledgerCtx: ReturnType<typeof createTestLedgerService> = createTestLedgerService(),
  /** Sprint 13: optional, so every Sprint 9–12 call site passing only 2 args is unaffected. */
  failedPaymentWorkflow?: FailedPaymentWorkflow,
  /** Sprint 17 review-pass addition: optional, so every pre-Sprint-17 call site is unaffected. */
  notifications?: NotificationService,
  profileOwners?: ProfileOwnerReader,
  /** PRSprint 18: optional, so every pre-PRSprint-18 call site is unaffected. */
  completion?: AgreementCompletionChecker,
) {
  const events = new InMemoryPaymentWebhookEventRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPayments();
  const paymentWebhookService = new PaymentWebhookService({
    provider: paymentCtx.provider,
    events,
    payments: paymentCtx.payments,
    ledger: ledgerCtx.ledgerService,
    audit: new AuditService(auditRepo),
    failedPaymentWorkflow,
    notifications,
    profileOwners,
    completion,
  });
  return { events, auditRepo, ledgerCtx, paymentWebhookService };
}
