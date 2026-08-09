import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryPersonalProfileRepository } from "@/lib/auth/testFakes";
import { BusinessProfileService } from "./businessProfileService";
import type { BusinessProfileRecord, BusinessProfileRepository, BusinessProfileStatus } from "./businessProfileService";
import { ProfileAccessService } from "./profileAccessService";
import { VerificationService } from "./verificationService";
import type {
  EmailVerificationReader,
  IdentityVerificationRecordRecord,
  IdentityVerificationRecordRepository,
  ProfileKind,
  ProfileOwnerReader,
  VerificationTier,
} from "./verificationService";

/** Test-only in-memory doubles, mirroring src/lib/auth/testFakes.ts's pattern. */

export class InMemoryIdentityVerificationRecordRepository implements IdentityVerificationRecordRepository {
  private byId = new Map<string, IdentityVerificationRecordRecord>();

  async insert(input: {
    profileKind: ProfileKind;
    profileId: string;
    tier: VerificationTier;
  }): Promise<IdentityVerificationRecordRecord> {
    const record: IdentityVerificationRecordRecord = {
      id: randomUUID(),
      status: "pending",
      reviewerUserId: null,
      decidedAt: null,
      decisionReason: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findLatestByProfile(
    profileKind: ProfileKind,
    profileId: string,
  ): Promise<IdentityVerificationRecordRecord | null> {
    const matches = [...this.byId.values()]
      .filter((r) => r.profileKind === profileKind && r.profileId === profileId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches.at(-1) ?? null;
  }

  async updateDecision(
    id: string,
    input: { status: "verified" | "rejected"; reviewerUserId: string; reason: string | null },
  ): Promise<void> {
    const record = this.byId.get(id);
    if (!record) return;
    record.status = input.status;
    record.reviewerUserId = input.reviewerUserId;
    record.decisionReason = input.reason;
    record.decidedAt = new Date();
  }
}

export class InMemoryEmailVerificationReader implements EmailVerificationReader {
  verifiedUserIds = new Set<string>();

  async isEmailVerified(userId: string): Promise<boolean> {
    return this.verifiedUserIds.has(userId);
  }
}

export class InMemoryProfileOwnerReader implements ProfileOwnerReader {
  owners = new Map<string, string>(); // `${kind}:${profileId}` -> userId

  set(profileKind: ProfileKind, profileId: string, userId: string): void {
    this.owners.set(`${profileKind}:${profileId}`, userId);
  }

  async getOwnerUserId(profileKind: ProfileKind, profileId: string): Promise<string | null> {
    return this.owners.get(`${profileKind}:${profileId}`) ?? null;
  }
}

class InMemoryAuditEventRepositoryForProfiles implements AuditEventRepository {
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

export class InMemoryBusinessProfileRepository implements BusinessProfileRepository {
  byId = new Map<string, BusinessProfileRecord>();

  async insert(input: {
    ownerUserId: string;
    legalBusinessName: string;
    displayName: string;
    entityType: string;
    businessAddress: unknown;
    country: string;
    state: string;
  }): Promise<BusinessProfileRecord> {
    const record: BusinessProfileRecord = {
      id: randomUUID(),
      status: "active",
      currency: "USD",
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<BusinessProfileRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listByOwner(ownerUserId: string): Promise<BusinessProfileRecord[]> {
    return [...this.byId.values()].filter((p) => p.ownerUserId === ownerUserId);
  }

  /** Test-only helper, not part of the BusinessProfileRepository interface. */
  setStatus(id: string, status: BusinessProfileStatus): void {
    const record = this.byId.get(id);
    if (record) record.status = status;
  }
}

export function createTestBusinessProfileService() {
  const repo = new InMemoryBusinessProfileRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForProfiles();
  const audit = new AuditService(auditRepo);
  const businessProfileService = new BusinessProfileService(repo, audit);
  return { businessProfileService, repo, auditRepo };
}

export function createTestProfileAccessService() {
  const personalProfiles = new InMemoryPersonalProfileRepository();
  const businessProfiles = new InMemoryBusinessProfileRepository();
  const profileAccessService = new ProfileAccessService(personalProfiles, businessProfiles);
  return { profileAccessService, personalProfiles, businessProfiles };
}

export function createTestVerificationService() {
  const records = new InMemoryIdentityVerificationRecordRepository();
  const emailVerification = new InMemoryEmailVerificationReader();
  const profileOwners = new InMemoryProfileOwnerReader();
  const auditRepo = new InMemoryAuditEventRepositoryForProfiles();
  const audit = new AuditService(auditRepo);
  const verificationService = new VerificationService(records, emailVerification, profileOwners, audit);
  return { verificationService, records, emailVerification, profileOwners, auditRepo };
}
