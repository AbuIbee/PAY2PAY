import { randomUUID } from "node:crypto";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryIdentityVerificationRecordRepository } from "@/lib/profiles/testFakes";
import { VerificationService } from "@/lib/profiles/verificationService";
import { B2BWorkflowService } from "./b2bWorkflowService";
import type { AgreementReferenceRecord, AgreementReferenceRepository } from "./b2bWorkflowService";
import type { B2BDashboardData, B2BDashboardReader } from "./b2bDashboardReader";

/** Test-only in-memory doubles for B2BWorkflowService, mirroring src/lib/agreements/testFakes.ts's pattern. */

export class InMemoryAgreementReferenceRepository implements AgreementReferenceRepository {
  rows = new Map<string, AgreementReferenceRecord>();

  async insert(input: {
    agreementId: string;
    referenceType: AgreementReferenceRecord["referenceType"];
    referenceNumber: string;
    addedByUserId: string;
  }): Promise<AgreementReferenceRecord> {
    const record: AgreementReferenceRecord = { id: randomUUID(), addedAt: new Date(), ...input };
    this.rows.set(record.id, record);
    return record;
  }

  async listForAgreement(agreementId: string): Promise<AgreementReferenceRecord[]> {
    return [...this.rows.values()].filter((r) => r.agreementId === agreementId);
  }
}

class InMemoryAuditEventRepositoryForB2B implements AuditEventRepository {
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

/** Builds a full B2BWorkflowService test context sharing the same underlying AgreementService/profileOwners instances, exactly as production does (both getB2BWorkflowService() and getAgreementService() resolve through the same singleton). */
export function createTestB2BWorkflowService() {
  const agreementCtx = createTestAgreementService();
  const verificationRecords = new InMemoryIdentityVerificationRecordRepository();
  const verificationService = new VerificationService(
    verificationRecords,
    { isEmailVerified: async () => true },
    agreementCtx.profileOwners,
    new AuditService(new InMemoryAuditEventRepositoryForB2B()),
  );
  const references = new InMemoryAgreementReferenceRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForB2B();

  const b2bWorkflowService = new B2BWorkflowService({
    agreementService: agreementCtx.agreementService,
    verification: verificationService,
    references,
    audit: new AuditService(auditRepo),
  });

  return { agreementCtx, b2bWorkflowService, references, verificationRecords, verificationService, auditRepo };
}

/** Test-only helper: marks a business profile FULL_VERIFIED without going through the real request/decide flow. */
export async function markBusinessFullyVerified(
  ctx: { verificationRecords: InMemoryIdentityVerificationRecordRepository },
  businessProfileId: string,
): Promise<void> {
  await markProfileFullyVerified(ctx, "business", businessProfileId);
}

/** Test-only helper: marks any profile (personal or business) FULL_VERIFIED, generically. */
export async function markProfileFullyVerified(
  ctx: { verificationRecords: InMemoryIdentityVerificationRecordRepository },
  profileKind: "personal" | "business",
  profileId: string,
): Promise<void> {
  const record = await ctx.verificationRecords.insert({ profileKind, profileId, tier: "full" });
  await ctx.verificationRecords.updateDecision(record.id, { status: "verified", reviewerUserId: randomUUID(), reason: null });
}

export class InMemoryB2BDashboardReader implements B2BDashboardReader {
  async getDashboard(): Promise<B2BDashboardData> {
    return {
      activeAgreementsCount: 0,
      accountsReceivableMinorUnits: 0,
      accountsPayableMinorUnits: 0,
      upcomingPayments: [],
      pastDuePayments: [],
      settlements: [],
      disputes: [],
    };
  }
}
