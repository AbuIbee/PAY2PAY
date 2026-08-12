import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import type { PartyRole } from "@/lib/agreements/agreementService";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { PartialPaymentService } from "./partialPaymentService";
import type { PartialPaymentRequestRecord, PartialPaymentRequestRepository, PartialPaymentRequestStatus } from "./partialPaymentService";

/** Test-only in-memory double for PartialPaymentRequestRepository, mirroring src/lib/amendments/testFakes.ts's pattern. */
export class InMemoryPartialPaymentRequestRepository implements PartialPaymentRequestRepository {
  byId = new Map<string, PartialPaymentRequestRecord>();

  async insert(input: {
    agreementId: string;
    installmentScheduleItemId: string | null;
    proposingPartyRole: PartyRole;
    proposedByProfileKind: ProfileKind;
    proposedByProfileId: string;
    proposedAmountMinorUnits: number;
    proposedDate: string;
    explanation: string | null;
    remainderTreatment: string | null;
  }): Promise<PartialPaymentRequestRecord> {
    const now = new Date();
    const record: PartialPaymentRequestRecord = {
      id: randomUUID(),
      status: "proposed",
      rejectedReason: null,
      rejectedAt: null,
      paymentAttemptId: null,
      appliedAt: null,
      expiredAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<PartialPaymentRequestRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForAgreement(agreementId: string): Promise<PartialPaymentRequestRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.agreementId === agreementId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private mustFind(id: string): PartialPaymentRequestRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("partial_payment_request not found");
    return record;
  }

  async updateProposedContent(
    id: string,
    input: {
      proposingPartyRole: PartyRole;
      proposedByProfileKind: ProfileKind;
      proposedByProfileId: string;
      proposedAmountMinorUnits: number;
      proposedDate: string;
      explanation: string | null;
      remainderTreatment: string | null;
    },
  ): Promise<PartialPaymentRequestRecord> {
    const record = this.mustFind(id);
    Object.assign(record, input);
    record.updatedAt = new Date();
    return record;
  }

  async updateStatus(id: string, status: PartialPaymentRequestStatus): Promise<PartialPaymentRequestRecord> {
    const record = this.mustFind(id);
    record.status = status;
    record.updatedAt = new Date();
    return record;
  }

  async recordRejection(id: string, reason: string | null): Promise<PartialPaymentRequestRecord> {
    const record = this.mustFind(id);
    record.status = "rejected";
    record.rejectedReason = reason;
    record.rejectedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordApplied(id: string, paymentAttemptId: string): Promise<PartialPaymentRequestRecord> {
    const record = this.mustFind(id);
    record.status = "applied";
    record.paymentAttemptId = paymentAttemptId;
    record.appliedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordExpired(id: string): Promise<PartialPaymentRequestRecord> {
    const record = this.mustFind(id);
    record.status = "expired";
    record.expiredAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async findAwaitingPaymentPastDate(now: Date): Promise<PartialPaymentRequestRecord[]> {
    return [...this.byId.values()].filter((r) => r.status === "awaiting_payment" && r.proposedDate < now.toISOString().slice(0, 10));
  }
}

class InMemoryAuditEventRepositoryForPartialPayments implements AuditEventRepository {
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
 * Full Sprint 15 test context, sharing one AgreementService instance set and one PaymentService
 * instance set with the underlying test fakes — exactly as production does, mirroring
 * src/lib/amendments/testFakes.ts's identical shared-context pattern.
 */
export function createTestPartialPaymentService() {
  const agreementCtx = createTestAgreementService();
  const paymentCtx = createTestPaymentService();
  const requests = new InMemoryPartialPaymentRequestRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPartialPayments();

  const partialPaymentService = new PartialPaymentService({
    agreementService: agreementCtx.agreementService,
    requests,
    payments: paymentCtx.payments,
    audit: new AuditService(auditRepo),
  });

  return { agreementCtx, paymentCtx, requests, auditRepo, partialPaymentService };
}
