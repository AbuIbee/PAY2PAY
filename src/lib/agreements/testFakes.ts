import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import { AgreementService } from "./agreementService";
import type {
  AgreementPartyRepository,
  AgreementRecord,
  AgreementRepository,
  AgreementStatus,
  AgreementVersionRecord,
  AgreementVersionRepository,
  FeeAllocation,
  InstallmentScheduleItemRepository,
  PartyRole,
} from "./agreementService";
import type { PaymentFrequency, ScheduleItem } from "./schedule";
import type { AgreementTerms } from "./agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";

/** Test-only in-memory doubles for AgreementService, mirroring src/lib/auth/testFakes.ts's pattern. */

export class InMemoryAgreementRepository implements AgreementRepository {
  byId = new Map<string, AgreementRecord>();

  async insert(input: {
    creditorProfileKind: ProfileKind;
    creditorProfileId: string;
    debtorProfileKind: ProfileKind;
    debtorProfileId: string;
    currency: string;
    createdByUserId: string;
  }): Promise<AgreementRecord> {
    const record: AgreementRecord = {
      id: randomUUID(),
      status: "draft",
      country: "US",
      currentVersionId: null,
      createdAt: new Date(),
      closedAt: null,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AgreementRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async updateStatus(id: string, status: AgreementStatus): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.status = status;
  }

  async setCurrentVersionId(id: string, versionId: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.currentVersionId = versionId;
  }

  async listForProfile(profileKind: ProfileKind, profileId: string): Promise<AgreementRecord[]> {
    return [...this.byId.values()].filter(
      (a) =>
        (a.creditorProfileKind === profileKind && a.creditorProfileId === profileId) ||
        (a.debtorProfileKind === profileKind && a.debtorProfileId === profileId),
    );
  }
}

export class InMemoryAgreementVersionRepository implements AgreementVersionRepository {
  byId = new Map<string, AgreementVersionRecord>();

  async insert(input: {
    agreementId: string;
    versionNumber: number;
    parentVersionId: string | null;
    isOriginal: boolean;
    producedBy: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
  }): Promise<AgreementVersionRecord> {
    const record: AgreementVersionRecord = {
      id: randomUUID(),
      documentHash: null,
      creditorSignedAt: null,
      debtorSignedAt: null,
      signedAt: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AgreementVersionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async updateTerms(
    id: string,
    input: { frequency: PaymentFrequency; feeAllocation: FeeAllocation; terms: AgreementTerms },
  ): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.frequency = input.frequency;
      record.feeAllocation = input.feeAllocation;
      record.terms = input.terms;
    }
  }

  async recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (!record) return;
    if (role === "creditor") record.creditorSignedAt = signedAt;
    else record.debtorSignedAt = signedAt;
  }

  async lock(id: string, input: { documentHash: string; signedAt: Date }): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.documentHash = input.documentHash;
      record.signedAt = input.signedAt;
    }
  }
}

export class InMemoryAgreementPartyRepository implements AgreementPartyRepository {
  rows: { agreementId: string; role: PartyRole; profileKind: ProfileKind; profileId: string }[] = [];

  async insert(input: { agreementId: string; role: PartyRole; profileKind: ProfileKind; profileId: string }): Promise<void> {
    this.rows.push(input);
  }
}

export class InMemoryInstallmentScheduleItemRepository implements InstallmentScheduleItemRepository {
  byVersionId = new Map<string, ScheduleItem[]>();

  async replaceForVersion(versionId: string, items: ScheduleItem[]): Promise<void> {
    this.byVersionId.set(versionId, items);
  }

  async listForVersion(versionId: string): Promise<ScheduleItem[]> {
    return this.byVersionId.get(versionId) ?? [];
  }
}

class InMemoryAuditEventRepositoryForAgreements implements AuditEventRepository {
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

export function createTestAgreementService() {
  const agreements = new InMemoryAgreementRepository();
  const versions = new InMemoryAgreementVersionRepository();
  const parties = new InMemoryAgreementPartyRepository();
  const scheduleItems = new InMemoryInstallmentScheduleItemRepository();
  const profileOwners = new InMemoryProfileOwnerReader();
  const staffCtx = createTestStaffService();
  const auditRepo = new InMemoryAuditEventRepositoryForAgreements();
  const audit = new AuditService(auditRepo);

  const agreementService = new AgreementService({
    agreements,
    versions,
    parties,
    scheduleItems,
    profileOwners,
    staffService: staffCtx.staffService,
    audit,
  });

  return { agreementService, agreements, versions, parties, scheduleItems, profileOwners, staffCtx, auditRepo };
}
