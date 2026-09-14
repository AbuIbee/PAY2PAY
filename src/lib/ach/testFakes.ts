import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryAgreementRepository } from "@/lib/agreements/testFakes";
import type { AgreementRecord } from "@/lib/agreements/agreementService";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import type { ProfileRef } from "@/lib/payments/paymentProvider";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import { AchMandateService } from "./achMandateService";
import type { AchMandateRecord, AchMandateRepository } from "./achMandateService";
import { AchPaymentService } from "./achPaymentService";

/**
 * R08 B1 (ACH-1): seeds a minimal, valid `AgreementRecord` directly by id in an
 * `InMemoryAgreementRepository`, for tests that need `AchMandateService.authorize`'s new
 * agreement-debtor-binding check to pass (or to deliberately fail with a mismatched debtor). Mirrors
 * the existing direct `relCtx.agreements.byId.get(...)`/`.set(...)` manipulation already used in
 * src/app/api/agreements/payment-setup/authorize-mandate/route.test.ts — not a new pattern.
 */
export function seedAgreementForMandateTest(
  agreements: InMemoryAgreementRepository,
  agreementId: string,
  debtor: ProfileRef,
  creditor: ProfileRef,
): AgreementRecord {
  const record: AgreementRecord = {
    id: agreementId,
    creditorProfileKind: creditor.profileKind,
    creditorProfileId: creditor.profileId,
    debtorProfileKind: debtor.profileKind,
    debtorProfileId: debtor.profileId,
    status: "active",
    currency: "USD",
    country: "US",
    currentVersionId: null,
    relationshipId: null,
    createdByUserId: creditor.profileId,
    createdAt: new Date(),
    closedAt: null,
  };
  agreements.byId.set(agreementId, record);
  return record;
}

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
  const agreements = new InMemoryAgreementRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForAch();
  const achMandateService = new AchMandateService({ mandates, profileOwners, agreements, audit: new AuditService(auditRepo) });
  return { mandates, profileOwners, agreements, auditRepo, achMandateService };
}

/**
 * Full ACH test context: AchMandateService + AchPaymentService sharing the same underlying
 * PaymentService/verification/profile-owner instances a real request would, so a mandate
 * authorized for a profile is recognized by the payment-scheduling gate too.
 */
export function createTestAchServices() {
  const paymentCtx = createTestPaymentService();
  const mandates = new InMemoryAchMandateRepository();
  const agreements = new InMemoryAgreementRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForAch();
  const achMandateService = new AchMandateService({
    mandates,
    profileOwners: paymentCtx.verificationCtx.profileOwners,
    agreements,
    audit: new AuditService(auditRepo),
  });
  const achPaymentService = new AchPaymentService({
    mandates: achMandateService,
    payments: paymentCtx.paymentService,
    paymentAttempts: paymentCtx.payments,
  });
  return { paymentCtx, mandates, agreements, auditRepo, achMandateService, achPaymentService };
}
