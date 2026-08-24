import { randomUUID } from "node:crypto";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryPersonalProfileRepository } from "@/lib/auth/testFakes";
import { InMemoryDocumentStorage } from "@/lib/documents/testFakes";
import { InMemoryIdentityVerificationRecordRepository, createTestAdminRoleServiceForProfiles } from "@/lib/profiles/testFakes";
import { VerificationService } from "@/lib/profiles/verificationService";
import { BasicFileValidator } from "./fileValidator";
import { EvidenceService } from "./evidenceService";
import type { EvidenceRecord, EvidenceRepository, EvidenceWithdrawalState } from "./evidenceService";
import { WitnessService } from "./witnessService";
import type { AgreementWitnessRecord, AgreementWitnessRepository } from "./witnessService";
import { WitnessReaderAdapter } from "./witnessReaderAdapter";

/** Test-only in-memory doubles for EvidenceService/WitnessService, mirroring src/lib/agreements/testFakes.ts's pattern. */

export class InMemoryEvidenceRepository implements EvidenceRepository {
  rows = new Map<string, EvidenceRecord>();

  async insert(
    input: Omit<EvidenceRecord, "id" | "uploadedAt" | "disputeFlag" | "withdrawalState">,
  ): Promise<EvidenceRecord> {
    const record: EvidenceRecord = {
      id: randomUUID(),
      uploadedAt: new Date(),
      disputeFlag: false,
      withdrawalState: "active",
      ...input,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<EvidenceRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async listForAgreement(agreementId: string): Promise<EvidenceRecord[]> {
    return [...this.rows.values()].filter((r) => r.agreementId === agreementId);
  }

  async updateWithdrawalState(id: string, state: EvidenceWithdrawalState): Promise<void> {
    const record = this.rows.get(id);
    if (record) record.withdrawalState = state;
  }

  async updateDisputeFlag(id: string, flag: boolean): Promise<void> {
    const record = this.rows.get(id);
    if (record) record.disputeFlag = flag;
  }
}

export class InMemoryAgreementWitnessRepository implements AgreementWitnessRepository {
  rows = new Map<string, AgreementWitnessRecord>();

  async insert(input: { agreementId: string; witnessUserId: string; addedByUserId: string }): Promise<AgreementWitnessRecord> {
    const record: AgreementWitnessRecord = {
      id: randomUUID(),
      addedAt: new Date(),
      attestedVersionId: null,
      attestedAt: null,
      ipAddress: null,
      deviceInfo: null,
      ...input,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async listForAgreement(agreementId: string): Promise<AgreementWitnessRecord[]> {
    return [...this.rows.values()].filter((r) => r.agreementId === agreementId);
  }

  async findByAgreementAndUser(agreementId: string, userId: string): Promise<AgreementWitnessRecord | null> {
    return [...this.rows.values()].find((r) => r.agreementId === agreementId && r.witnessUserId === userId) ?? null;
  }

  async recordAttestation(
    id: string,
    input: { attestedVersionId: string; attestedAt: Date; ipAddress: string | null; deviceInfo: unknown },
  ): Promise<void> {
    const record = this.rows.get(id);
    if (record) {
      record.attestedVersionId = input.attestedVersionId;
      record.attestedAt = input.attestedAt;
      record.ipAddress = input.ipAddress;
      record.deviceInfo = input.deviceInfo;
    }
  }
}

class InMemoryAuditEventRepositoryForEvidence implements AuditEventRepository {
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
 * Builds a full Evidence + Witness test context sharing the same underlying AgreementService and
 * profileOwners instances (exactly as production does — both getEvidenceService() and
 * getWitnessService() resolve through getAgreementService()'s singleton), so a party/agreement
 * seeded once via `ctx.agreementCtx` is visible to both services under test.
 */
export function createTestEvidenceWitnessContext() {
  const agreementCtx = createTestAgreementService();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const witnessRepo = new InMemoryAgreementWitnessRepository();
  const storage = new InMemoryDocumentStorage();
  const fileValidator = new BasicFileValidator();
  const personalProfiles = new InMemoryPersonalProfileRepository();
  const verificationRecords = new InMemoryIdentityVerificationRecordRepository();
  const evidenceAuditRepo = new InMemoryAuditEventRepositoryForEvidence();
  const witnessAuditRepo = new InMemoryAuditEventRepositoryForEvidence();
  const verificationService = new VerificationService(
    verificationRecords,
    { isEmailVerified: async () => true },
    agreementCtx.profileOwners,
    new AuditService(new InMemoryAuditEventRepositoryForEvidence()),
    createTestAdminRoleServiceForProfiles(),
  );

  const evidenceService = new EvidenceService({
    agreementService: agreementCtx.agreementService,
    evidence: evidenceRepo,
    witnesses: new WitnessReaderAdapter(witnessRepo),
    storage,
    fileValidator,
    audit: new AuditService(evidenceAuditRepo),
  });

  const witnessService = new WitnessService({
    agreementService: agreementCtx.agreementService,
    witnesses: witnessRepo,
    agreements: agreementCtx.agreements,
    versions: agreementCtx.versions,
    scheduleItems: agreementCtx.scheduleItems,
    personalProfiles,
    profileOwners: agreementCtx.profileOwners,
    verification: verificationService,
    audit: new AuditService(witnessAuditRepo),
  });

  return {
    agreementCtx,
    evidenceService,
    witnessService,
    evidenceRepo,
    witnessRepo,
    storage,
    personalProfiles,
    verificationRecords,
    evidenceAuditRepo,
    witnessAuditRepo,
  };
}

/** Test-only helper: registers a personal-profile witness candidate consistently, and marks them FULL_VERIFIED. */
export async function seedVerifiedPersonalUser(
  ctx: ReturnType<typeof createTestEvidenceWitnessContext>,
  userId: string,
): Promise<string> {
  const profile = await ctx.personalProfiles.insert(userId);
  ctx.agreementCtx.profileOwners.set("personal", profile.id, userId);
  const record = await ctx.verificationRecords.insert({ profileKind: "personal", profileId: profile.id, tier: "full" });
  await ctx.verificationRecords.updateDecision(record.id, { status: "verified", reviewerUserId: randomUUID(), reason: null });
  return profile.id;
}
