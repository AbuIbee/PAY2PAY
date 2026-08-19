import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import { AchMandateService } from "./achMandateService";
import type { AchMandateRecord, AchMandateRepository } from "./achMandateService";
import { AchPaymentService } from "./achPaymentService";

/** Test-only in-memory doubles for AchMandateService, mirroring src/lib/payments/testFakes.ts's pattern. */

export class InMemoryAchMandateRepository implements AchMandateRepository {
  byId = new Map<string, AchMandateRecord>();

  async insert(input: {
    agreementId: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    bankAccountRef: string;
    supersedesMandateId: string | null;
  }): Promise<AchMandateRecord> {
    const now = new Date();
    const record: AchMandateRecord = {
      id: randomUUID(),
      status: "active",
      authorizedAt: now,
      revokedAt: null,
      revokedReason: null,
      financialAccountId: null,
      createdAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findActiveForAgreement(agreementId: string): Promise<AchMandateRecord | null> {
    return [...this.byId.values()].find((m) => m.agreementId === agreementId && m.status === "active") ?? null;
  }

  async findById(id: string): Promise<AchMandateRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async markRevoked(id: string, revokedAt: Date, revokedReason: string): Promise<AchMandateRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("ach_mandate not found");
    record.status = "revoked";
    record.revokedAt = revokedAt;
    record.revokedReason = revokedReason;
    return record;
  }
}

class InMemoryAuditEventRepositoryForAch implements AuditEventRepository {
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

export function createTestAchMandateService() {
  const mandates = new InMemoryAchMandateRepository();
  const profileOwners = new InMemoryProfileOwnerReader();
  const auditRepo = new InMemoryAuditEventRepositoryForAch();
  const achMandateService = new AchMandateService({ mandates, profileOwners, audit: new AuditService(auditRepo) });
  return { mandates, profileOwners, auditRepo, achMandateService };
}

/**
 * Full ACH test context: AchMandateService + AchPaymentService sharing the same underlying
 * PaymentService/verification/profile-owner instances a real request would, so a mandate
 * authorized for a profile is recognized by the payment-scheduling gate too.
 */
export function createTestAchServices() {
  const paymentCtx = createTestPaymentService();
  const mandates = new InMemoryAchMandateRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForAch();
  const achMandateService = new AchMandateService({
    mandates,
    profileOwners: paymentCtx.verificationCtx.profileOwners,
    audit: new AuditService(auditRepo),
  });
  const achPaymentService = new AchPaymentService({
    mandates: achMandateService,
    payments: paymentCtx.paymentService,
    paymentAttempts: paymentCtx.payments,
  });
  return { paymentCtx, mandates, auditRepo, achMandateService, achPaymentService };
}
