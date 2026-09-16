import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { ConfigurationError } from "@/lib/errors";
import type { LedgerService } from "@/lib/ledger/ledgerService";
import type { PaymentAttemptRepository } from "@/lib/payments/paymentService";
import type { VerificationService } from "@/lib/profiles/verificationService";
import type { PayoutAttemptRecord, PayoutAttemptRepository } from "./payoutAttemptRepository";
import { PayoutService } from "./payoutService";

export class InMemoryPayoutAttemptRepository implements PayoutAttemptRepository {
  byId = new Map<string, PayoutAttemptRecord>();

  async insert(input: { paymentAttemptId: string; agreementId: string }): Promise<PayoutAttemptRecord> {
    const existing = [...this.byId.values()].find((r) => r.paymentAttemptId === input.paymentAttemptId);
    if (existing) throw new Error('duplicate key value violates unique constraint "payout_attempt_payment_attempt_id_unique"');
    const record: PayoutAttemptRecord = {
      id: randomUUID(),
      paymentAttemptId: input.paymentAttemptId,
      agreementId: input.agreementId,
      status: "pending",
      createdAt: new Date(),
      confirmedAt: null,
      providerName: null,
      providerPayoutReference: null,
      failedAt: null,
      failureReason: null,
      returnedAt: null,
      returnReason: null,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByPaymentAttemptId(paymentAttemptId: string): Promise<PayoutAttemptRecord | null> {
    return [...this.byId.values()].find((r) => r.paymentAttemptId === paymentAttemptId) ?? null;
  }

  private mustFind(id: string): PayoutAttemptRecord {
    const record = this.byId.get(id);
    if (!record) throw new ConfigurationError("payout_attempt not found");
    return record;
  }

  async markConfirmed(id: string, input: { confirmedAt: Date; providerName: string; providerPayoutReference: string }): Promise<PayoutAttemptRecord> {
    const record = this.mustFind(id);
    record.status = "confirmed";
    record.confirmedAt = input.confirmedAt;
    record.providerName = input.providerName;
    record.providerPayoutReference = input.providerPayoutReference;
    return record;
  }

  async markFailed(id: string, input: { failedAt: Date; failureReason: string }): Promise<PayoutAttemptRecord> {
    const record = this.mustFind(id);
    record.status = "failed";
    record.failedAt = input.failedAt;
    record.failureReason = input.failureReason;
    return record;
  }

  async markReturned(id: string, input: { returnedAt: Date; returnReason: string }): Promise<PayoutAttemptRecord> {
    const record = this.mustFind(id);
    record.status = "returned";
    record.returnedAt = input.returnedAt;
    record.returnReason = input.returnReason;
    return record;
  }
}

class InMemoryAuditEventRepositoryForPayouts implements AuditEventRepository {
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
 * PAID2YOU — B0-D PHASE 3D (payout status accuracy). A minimal, standalone fake for routes/components
 * that only need `PayoutService.getPayoutStatus` (read-only reporting) — never the full lifecycle
 * (`confirmPayout`/`returnPayout`), which is what `createTestPayoutService` above is for. Avoids
 * forcing every payout-status-display test to also wire a `LedgerService`/`PaymentAttemptRepository`
 * it has no use for.
 */
export class FakePayoutStatusReader {
  private byPaymentAttemptId = new Map<string, PayoutAttemptRecord>();

  /** Seeds a payout_attempt row for a payment, with sensible defaults for every field this fake's callers don't care about. */
  seed(paymentAttemptId: string, status: PayoutAttemptRecord["status"], overrides: Partial<PayoutAttemptRecord> = {}): void {
    this.byPaymentAttemptId.set(paymentAttemptId, {
      id: randomUUID(),
      paymentAttemptId,
      agreementId: "fake-agreement",
      status,
      createdAt: new Date(),
      confirmedAt: status === "confirmed" || status === "returned" ? new Date() : null,
      providerName: status === "confirmed" || status === "returned" ? "adyen" : null,
      providerPayoutReference: status === "confirmed" || status === "returned" ? "psp_fake" : null,
      failedAt: status === "failed" ? new Date() : null,
      failureReason: status === "failed" ? "provider rejected transfer" : null,
      returnedAt: status === "returned" ? new Date() : null,
      returnReason: status === "returned" ? "bank returned the transfer" : null,
      ...overrides,
    });
  }

  async getPayoutStatus(paymentAttemptId: string): Promise<PayoutAttemptRecord | null> {
    return this.byPaymentAttemptId.get(paymentAttemptId) ?? null;
  }
}

/**
 * Test harness: a real `PayoutService` over an in-memory `payoutAttempts` repository, sharing a
 * caller-supplied `ledger`/`payments` so it exercises real ledger-posting/payment-status behavior
 * against the exact same fakes the rest of a test's own webhook/ledger context already uses.
 *
 * PAID2YOU — B0-D PHASE 3B (payout integrity): `payoutProviderIntegrationVerified` defaults to `true`
 * so every pre-existing (PHASE 3A) test that exercises real `confirmPayout` completion is unaffected —
 * mirrors this codebase's established "optional override, defaults to the pre-existing behavior"
 * convention. PHASE 3B's own tests pass `false` explicitly to prove the gate.
 *
 * PAID2YOU — B0-D PHASE 3C (creditor payout eligibility): `verification` defaults to a permissive
 * stub (`isFullyVerified` always resolves `true`) for the identical reason — every pre-existing test
 * that exercises real `confirmPayout` completion was written before this gate existed and never
 * intended to exercise it. PHASE 3C's own tests pass a real `VerificationService` (via
 * `createTestVerificationService()`) to prove the gate against genuine per-profile verification state.
 */
export function createTestPayoutService(deps: {
  ledger: LedgerService;
  payments: Pick<PaymentAttemptRepository, "findById" | "markPayoutCompleted" | "clearPayoutCompleted">;
  payoutProviderIntegrationVerified?: boolean;
  verification?: Pick<VerificationService, "isFullyVerified">;
}) {
  const payoutAttempts = new InMemoryPayoutAttemptRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPayouts();
  const payoutService = new PayoutService({
    payoutAttempts,
    ledger: deps.ledger,
    payments: deps.payments,
    audit: new AuditService(auditRepo),
    verification: deps.verification ?? { isFullyVerified: async () => true },
    payoutProviderIntegrationVerified: deps.payoutProviderIntegrationVerified ?? true,
  });
  return { payoutAttempts, auditRepo, payoutService };
}
