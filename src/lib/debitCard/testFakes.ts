import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import type { AgreementFeeAllocationReader, FeeAllocation } from "./agreementFeeAllocationReader";
import { DebitCardMethodService } from "./debitCardMethodService";
import type { DebitCardMethodRecord, DebitCardMethodRepository } from "./debitCardMethodService";
import { DebitCardPaymentService } from "./debitCardPaymentService";

/** Test-only in-memory doubles for DebitCardMethodService/DebitCardPaymentService, mirroring src/lib/ach/testFakes.ts's pattern. */

export class InMemoryDebitCardMethodRepository implements DebitCardMethodRepository {
  byId = new Map<string, DebitCardMethodRecord>();

  async insert(input: {
    agreementId: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    cardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    supersedesCardMethodId: string | null;
  }): Promise<DebitCardMethodRecord> {
    const now = new Date();
    const record: DebitCardMethodRecord = {
      id: randomUUID(),
      status: "active",
      registeredAt: now,
      replacedAt: null,
      replacedReason: null,
      createdAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findActiveForAgreement(agreementId: string): Promise<DebitCardMethodRecord | null> {
    return [...this.byId.values()].find((c) => c.agreementId === agreementId && c.status === "active") ?? null;
  }

  async findById(id: string): Promise<DebitCardMethodRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async markReplaced(id: string, replacedAt: Date, replacedReason: string): Promise<DebitCardMethodRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("debit_card_method not found");
    record.status = "replaced";
    record.replacedAt = replacedAt;
    record.replacedReason = replacedReason;
    return record;
  }
}

/** Test-only in-memory doubles for AgreementFeeAllocationReader — a plain settable map, no agreement/version join needed for these tests. */
export class InMemoryAgreementFeeAllocationReader implements AgreementFeeAllocationReader {
  private byAgreementId = new Map<string, FeeAllocation>();

  set(agreementId: string, feeAllocation: FeeAllocation): void {
    this.byAgreementId.set(agreementId, feeAllocation);
  }

  async getFeeAllocation(agreementId: string): Promise<FeeAllocation | null> {
    return this.byAgreementId.get(agreementId) ?? null;
  }
}

class InMemoryAuditEventRepositoryForDebitCard implements AuditEventRepository {
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

/** Standalone DebitCardMethodService test context (no PaymentService), mirroring src/lib/ach/testFakes.ts's createTestAchMandateService. */
export function createTestDebitCardMethodService() {
  const cards = new InMemoryDebitCardMethodRepository();
  const profileOwners = new InMemoryProfileOwnerReader();
  const auditRepo = new InMemoryAuditEventRepositoryForDebitCard();
  const debitCardMethodService = new DebitCardMethodService({ cards, profileOwners, audit: new AuditService(auditRepo) });
  return { cards, profileOwners, auditRepo, debitCardMethodService };
}

/**
 * Full debit-card test context: DebitCardMethodService + DebitCardPaymentService sharing the same
 * underlying PaymentService/verification/profile-owner instances a real request would, exactly
 * mirroring src/lib/ach/testFakes.ts's createTestAchServices.
 */
export function createTestDebitCardServices() {
  const paymentCtx = createTestPaymentService();
  const cards = new InMemoryDebitCardMethodRepository();
  const feeAllocation = new InMemoryAgreementFeeAllocationReader();
  const auditRepo = new InMemoryAuditEventRepositoryForDebitCard();
  const debitCardMethodService = new DebitCardMethodService({
    cards,
    profileOwners: paymentCtx.verificationCtx.profileOwners,
    audit: new AuditService(auditRepo),
  });
  const debitCardPaymentService = new DebitCardPaymentService({
    cards: debitCardMethodService,
    payments: paymentCtx.paymentService,
    paymentAttempts: paymentCtx.payments,
    feeAllocation,
  });
  return { paymentCtx, cards, feeAllocation, auditRepo, debitCardMethodService, debitCardPaymentService };
}

/** Convenience: a valid, far-future (never expires in a test's lifetime) expiry pair. */
export const TEST_FUTURE_CARD_EXPIRY = { expiresAtMonth: 12, expiresAtYear: new Date().getUTCFullYear() + 5 };
/** Convenience: an expiry pair guaranteed to already be in the past. */
export const TEST_PAST_CARD_EXPIRY = { expiresAtMonth: 1, expiresAtYear: 2000 };
