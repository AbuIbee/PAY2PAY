import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import type { AgreementTerms, FeeAllocation, PartyRole } from "@/lib/agreements/agreementService";
import type { PaymentFrequency } from "@/lib/agreements/schedule";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { AmendmentService } from "./amendmentService";
import type { AmendmentChangeType, AmendmentRecord, AmendmentRepository, AmendmentStatus } from "./amendmentService";

/** Test-only in-memory double for AmendmentRepository, mirroring every other module's testFakes.ts pattern in this codebase. */
export class InMemoryAmendmentRepository implements AmendmentRepository {
  byId = new Map<string, AmendmentRecord>();

  async insert(input: {
    agreementId: string;
    changeType: AmendmentChangeType;
    proposingPartyRole: PartyRole;
    proposedByProfileKind: ProfileKind;
    proposedByProfileId: string;
    reason: string;
    requestedRelief: string | null;
    proposedEffectiveDate: string | null;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
  }): Promise<AmendmentRecord> {
    const now = new Date();
    const record: AmendmentRecord = {
      id: randomUUID(),
      status: "proposed",
      creditorSignedAt: null,
      debtorSignedAt: null,
      signedAt: null,
      resultingVersionId: null,
      rejectedReason: null,
      rejectedAt: null,
      withdrawnReason: null,
      withdrawnAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AmendmentRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForAgreement(agreementId: string): Promise<AmendmentRecord[]> {
    return [...this.byId.values()]
      .filter((a) => a.agreementId === agreementId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private mustFind(id: string): AmendmentRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("amendment not found");
    return record;
  }

  async updateProposedTerms(
    id: string,
    input: {
      proposingPartyRole: PartyRole;
      proposedByProfileKind: ProfileKind;
      proposedByProfileId: string;
      reason: string;
      requestedRelief: string | null;
      proposedEffectiveDate: string | null;
      frequency: PaymentFrequency;
      feeAllocation: FeeAllocation;
      terms: AgreementTerms;
    },
  ): Promise<AmendmentRecord> {
    const record = this.mustFind(id);
    Object.assign(record, input);
    record.updatedAt = new Date();
    return record;
  }

  async updateStatus(id: string, status: AmendmentStatus): Promise<AmendmentRecord> {
    const record = this.mustFind(id);
    record.status = status;
    record.updatedAt = new Date();
    return record;
  }

  async recordRejection(id: string, reason: string | null): Promise<AmendmentRecord> {
    const record = this.mustFind(id);
    record.status = "rejected";
    record.rejectedReason = reason;
    record.rejectedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordWithdrawal(id: string, reason: string | null): Promise<AmendmentRecord> {
    const record = this.mustFind(id);
    record.status = "withdrawn";
    record.withdrawnReason = reason;
    record.withdrawnAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<AmendmentRecord> {
    const record = this.mustFind(id);
    if (role === "creditor") record.creditorSignedAt = signedAt;
    else record.debtorSignedAt = signedAt;
    record.updatedAt = new Date();
    return record;
  }

  async recordApplied(id: string, resultingVersionId: string): Promise<AmendmentRecord> {
    const record = this.mustFind(id);
    record.status = "applied";
    record.resultingVersionId = resultingVersionId;
    record.updatedAt = new Date();
    return record;
  }
}

class InMemoryAuditEventRepositoryForAmendments implements AuditEventRepository {
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
 * Full Sprint 14 test context, sharing one `AgreementService`/versions/agreements/scheduleItems
 * instance set with the underlying agreement-engine test fakes — exactly as production does, and
 * mirroring every prior sprint's shared-context testFakes.ts pattern (e.g. `createTestAchServices`).
 */
export function createTestAmendmentService() {
  const agreementCtx = createTestAgreementService();
  const amendments = new InMemoryAmendmentRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForAmendments();

  const amendmentService = new AmendmentService({
    agreementService: agreementCtx.agreementService,
    amendments,
    versions: agreementCtx.versions,
    agreements: agreementCtx.agreements,
    scheduleItems: agreementCtx.scheduleItems,
    audit: new AuditService(auditRepo),
  });

  return { agreementCtx, amendments, auditRepo, amendmentService };
}
