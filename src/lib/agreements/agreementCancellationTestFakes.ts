import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestAgreementService } from "./testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import type { PartyRole } from "./agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { AgreementCancellationService } from "./agreementCancellationService";
import type { AgreementCancellationRequestRecord, AgreementCancellationRequestRepository } from "./agreementCancellationService";

/** Test-only in-memory double for AgreementCancellationRequestRepository, mirroring src/lib/partialPayments/testFakes.ts's identical pattern. */
export class InMemoryAgreementCancellationRequestRepository implements AgreementCancellationRequestRepository {
  byId = new Map<string, AgreementCancellationRequestRecord>();

  async insert(input: {
    agreementId: string;
    requestedByPartyRole: PartyRole;
    requestedByProfileKind: ProfileKind;
    requestedByProfileId: string;
    reason: string;
  }): Promise<AgreementCancellationRequestRecord> {
    const now = new Date();
    const record: AgreementCancellationRequestRecord = {
      id: randomUUID(),
      status: "pending",
      decidedByProfileKind: null,
      decidedByProfileId: null,
      rejectedReason: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AgreementCancellationRequestRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForAgreement(agreementId: string): Promise<AgreementCancellationRequestRecord[]> {
    return [...this.byId.values()].filter((r) => r.agreementId === agreementId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private mustFind(id: string): AgreementCancellationRequestRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("agreement_cancellation_request not found");
    return record;
  }

  async recordAccepted(id: string, decidedBy: { profileKind: ProfileKind; profileId: string }): Promise<AgreementCancellationRequestRecord> {
    const record = this.mustFind(id);
    record.status = "accepted";
    record.decidedByProfileKind = decidedBy.profileKind;
    record.decidedByProfileId = decidedBy.profileId;
    record.decidedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordRejected(
    id: string,
    decidedBy: { profileKind: ProfileKind; profileId: string },
    rejectedReason: string | null,
  ): Promise<AgreementCancellationRequestRecord> {
    const record = this.mustFind(id);
    record.status = "rejected";
    record.decidedByProfileKind = decidedBy.profileKind;
    record.decidedByProfileId = decidedBy.profileId;
    record.rejectedReason = rejectedReason;
    record.decidedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }
}

class InMemoryAuditEventRepositoryForCancellation implements AuditEventRepository {
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

/** Full test context, sharing one AgreementService and one NotificationService instance set with the underlying test fakes — mirrors src/lib/partialPayments/testFakes.ts's identical shared-context pattern. */
export function createTestAgreementCancellationService() {
  const agreementCtx = createTestAgreementService();
  const notifyCtx = createTestNotificationService();
  const requests = new InMemoryAgreementCancellationRequestRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForCancellation();

  const cancellationService = new AgreementCancellationService({
    agreementService: agreementCtx.agreementService,
    requests,
    profileOwners: agreementCtx.profileOwners,
    notifications: notifyCtx.notificationService,
    audit: new AuditService(auditRepo),
  });

  return { agreementCtx, notifyCtx, requests, auditRepo, cancellationService };
}
