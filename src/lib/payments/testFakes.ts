import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { PaymentService } from "./paymentService";
import type { PaymentAttemptRecord, PaymentAttemptRepository, PaymentAttemptStatus } from "./paymentService";
import { PaymentWebhookService } from "./paymentWebhookService";
import type { PaymentWebhookEventRecord, PaymentWebhookEventRepository } from "./paymentWebhookService";
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
  }): Promise<PaymentAttemptRecord> {
    if (this.idempotencyKeys.has(input.idempotencyKey)) {
      throw new Error("duplicate idempotency key");
    }
    this.idempotencyKeys.add(input.idempotencyKey);
    const now = new Date();
    const record: PaymentAttemptRecord = {
      id: randomUUID(),
      status: "pending",
      providerPaymentId: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      ...input,
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

  async findById(id: string): Promise<PaymentAttemptRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PaymentAttemptRecord | null> {
    return [...this.byId.values()].find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<PaymentAttemptRecord | null> {
    return [...this.byId.values()].find((r) => r.providerPaymentId === providerPaymentId) ?? null;
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

/** Builds a full PaymentService test context sharing the same underlying VerificationService/profileOwners instances, exactly as production does. */
export function createTestPaymentService() {
  const verificationCtx = createTestVerificationService();
  const provider = new SandboxPaymentProvider(TEST_WEBHOOK_SECRET);
  const payments = new InMemoryPaymentAttemptRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPayments();

  const paymentService = new PaymentService({
    provider,
    verification: verificationCtx.verificationService,
    profileOwners: verificationCtx.profileOwners,
    payments,
    audit: new AuditService(auditRepo),
  });

  return { verificationCtx, provider, payments, auditRepo, paymentService };
}

export class InMemoryPaymentWebhookEventRepository implements PaymentWebhookEventRepository {
  private byId = new Map<string, PaymentWebhookEventRecord>();

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
    const existing = await this.findByProviderEvent(input.provider, input.providerEventId);
    if (existing) throw new Error("duplicate webhook event");
    const record: PaymentWebhookEventRecord = { id: randomUUID(), receivedAt: new Date(), processedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async markProcessed(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.processedAt = new Date();
  }
}

/** Builds a full PaymentWebhookService test context sharing the same provider/payments repo as an existing PaymentService context (pass one in to correlate webhook events with payments already created through it). */
export function createTestPaymentWebhookService(paymentCtx: ReturnType<typeof createTestPaymentService>) {
  const events = new InMemoryPaymentWebhookEventRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPayments();
  const paymentWebhookService = new PaymentWebhookService({
    provider: paymentCtx.provider,
    events,
    payments: paymentCtx.payments,
    audit: new AuditService(auditRepo),
  });
  return { events, auditRepo, paymentWebhookService };
}
