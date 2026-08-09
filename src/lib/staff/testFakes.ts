import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemorySessionRepository, InMemoryEmailSender } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import type { MfaService } from "@/lib/auth/mfaService";
import type { BusinessApprovalPolicyRecord, BusinessApprovalPolicyRepository, StaffApprovalRequestRecord, StaffApprovalRequestRepository } from "./approvalService";
import { ApprovalService } from "./approvalService";
import type { Capability, StaffRole } from "./capabilities";
import type {
  BusinessStaffMemberRecord,
  BusinessStaffMemberRepository,
  CustomRoleRecord,
  CustomRoleRepository,
  StaffInvitationRecord,
  StaffInvitationRepository,
  UserEmailReader,
} from "./staffService";
import { StaffService } from "./staffService";

/** Test-only in-memory doubles for StaffService/ApprovalService, mirroring src/lib/auth/testFakes.ts's pattern. */

export class InMemoryBusinessStaffMemberRepository implements BusinessStaffMemberRepository {
  byId = new Map<string, BusinessStaffMemberRecord>();

  async insert(input: {
    businessProfileId: string;
    userId: string;
    role: StaffRole;
    customRoleId: string | null;
    isAuthorizedRepresentative: boolean;
  }): Promise<BusinessStaffMemberRecord> {
    const record: BusinessStaffMemberRecord = {
      id: randomUUID(),
      removedAt: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<BusinessStaffMemberRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findActiveByBusinessAndUser(businessProfileId: string, userId: string): Promise<BusinessStaffMemberRecord | null> {
    for (const member of this.byId.values()) {
      if (member.businessProfileId === businessProfileId && member.userId === userId && !member.removedAt) {
        return member;
      }
    }
    return null;
  }

  async listActiveByBusiness(businessProfileId: string): Promise<BusinessStaffMemberRecord[]> {
    return [...this.byId.values()].filter((m) => m.businessProfileId === businessProfileId && !m.removedAt);
  }

  async updateRole(id: string, input: { role: StaffRole; customRoleId: string | null }): Promise<void> {
    const member = this.byId.get(id);
    if (member) {
      member.role = input.role;
      member.customRoleId = input.customRoleId;
    }
  }

  async markRemoved(id: string, removedAt: Date): Promise<void> {
    const member = this.byId.get(id);
    if (member) member.removedAt = removedAt;
  }

  /** Test-only helper: directly seed a staff member without going through invitations. */
  seed(input: {
    businessProfileId: string;
    userId: string;
    role: StaffRole;
    customRoleId?: string | null;
  }): BusinessStaffMemberRecord {
    const record: BusinessStaffMemberRecord = {
      id: randomUUID(),
      businessProfileId: input.businessProfileId,
      userId: input.userId,
      role: input.role,
      customRoleId: input.customRoleId ?? null,
      isAuthorizedRepresentative: false,
      removedAt: null,
      createdAt: new Date(),
    };
    this.byId.set(record.id, record);
    return record;
  }
}

export class InMemoryCustomRoleRepository implements CustomRoleRepository {
  byId = new Map<string, CustomRoleRecord>();

  async insert(input: { businessProfileId: string; name: string; permissions: Capability[] }): Promise<CustomRoleRecord> {
    const record: CustomRoleRecord = { id: randomUUID(), ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<CustomRoleRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async update(id: string, input: { name?: string; permissions?: Capability[] }): Promise<void> {
    const record = this.byId.get(id);
    if (!record) return;
    if (input.name !== undefined) record.name = input.name;
    if (input.permissions !== undefined) record.permissions = input.permissions;
  }

  async listByBusiness(businessProfileId: string): Promise<CustomRoleRecord[]> {
    return [...this.byId.values()].filter((r) => r.businessProfileId === businessProfileId);
  }
}

export class InMemoryStaffInvitationRepository implements StaffInvitationRepository {
  byId = new Map<string, StaffInvitationRecord>();

  async insert(input: {
    businessProfileId: string;
    email: string;
    role: StaffRole;
    customRoleId: string | null;
    invitedByUserId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<StaffInvitationRecord> {
    const record: StaffInvitationRecord = {
      id: randomUUID(),
      status: "pending",
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<StaffInvitationRecord | null> {
    for (const invitation of this.byId.values()) {
      if (invitation.tokenHash === tokenHash) return invitation;
    }
    return null;
  }

  async findPendingByBusinessAndEmail(businessProfileId: string, email: string): Promise<StaffInvitationRecord | null> {
    for (const invitation of this.byId.values()) {
      if (invitation.businessProfileId === businessProfileId && invitation.email === email && invitation.status === "pending") {
        return invitation;
      }
    }
    return null;
  }

  async markAccepted(id: string, input: { acceptedByUserId: string; acceptedAt: Date }): Promise<void> {
    const invitation = this.byId.get(id);
    if (invitation) {
      invitation.status = "accepted";
      invitation.acceptedByUserId = input.acceptedByUserId;
      invitation.acceptedAt = input.acceptedAt;
    }
  }
}

export class InMemoryUserEmailReader implements UserEmailReader {
  emails = new Map<string, string>();

  set(userId: string, email: string): void {
    this.emails.set(userId, email);
  }

  async getEmailByUserId(userId: string): Promise<string | null> {
    return this.emails.get(userId) ?? null;
  }
}

export class InMemoryBusinessApprovalPolicyRepository implements BusinessApprovalPolicyRepository {
  private byKey = new Map<string, BusinessApprovalPolicyRecord>();

  private key(businessProfileId: string, capability: Capability): string {
    return `${businessProfileId}:${capability}`;
  }

  async upsert(input: {
    businessProfileId: string;
    capability: Capability;
    thresholdMinorUnits: number | null;
    requiresDualApproval: boolean;
    requiresOwner: boolean;
    updatedByUserId: string;
  }): Promise<BusinessApprovalPolicyRecord> {
    const key = this.key(input.businessProfileId, input.capability);
    const existing = this.byKey.get(key);
    const record: BusinessApprovalPolicyRecord = {
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? new Date(),
      ...input,
      updatedAt: new Date(),
    };
    this.byKey.set(key, record);
    return record;
  }

  async findByBusinessAndCapability(businessProfileId: string, capability: Capability): Promise<BusinessApprovalPolicyRecord | null> {
    return this.byKey.get(this.key(businessProfileId, capability)) ?? null;
  }

  async listByBusiness(businessProfileId: string): Promise<BusinessApprovalPolicyRecord[]> {
    return [...this.byKey.values()].filter((p) => p.businessProfileId === businessProfileId);
  }
}

export class InMemoryStaffApprovalRequestRepository implements StaffApprovalRequestRepository {
  byId = new Map<string, StaffApprovalRequestRecord>();

  async insert(input: {
    businessProfileId: string;
    proposedByStaffId: string;
    relatedAgreementId: string | null;
    actionType: Capability;
    actionPayload: unknown;
    reasonFlagged: string;
  }): Promise<StaffApprovalRequestRecord> {
    const record: StaffApprovalRequestRecord = {
      id: randomUUID(),
      status: "pending",
      approvedByStaffId: null,
      decidedAt: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<StaffApprovalRequestRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async updateDecision(
    id: string,
    input: { status: "approved" | "rejected"; approvedByStaffId: string; decidedAt: Date },
  ): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.status = input.status;
      record.approvedByStaffId = input.approvedByStaffId;
      record.decidedAt = input.decidedAt;
    }
  }
}

class InMemoryAuditEventRepositoryForStaff implements AuditEventRepository {
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

const TEST_APP_URL = "http://localhost:3000";

export function createTestStaffService() {
  const staffMembers = new InMemoryBusinessStaffMemberRepository();
  const customRoles = new InMemoryCustomRoleRepository();
  const invitations = new InMemoryStaffInvitationRepository();
  const sessions = new InMemorySessionRepository();
  const { mfaService, credentials: mfaCredentials, stepUps } = createTestMfaService();
  const userEmails = new InMemoryUserEmailReader();
  const auditRepo = new InMemoryAuditEventRepositoryForStaff();
  const audit = new AuditService(auditRepo);
  const emailSender = new InMemoryEmailSender();

  const staffService = new StaffService(
    staffMembers,
    customRoles,
    invitations,
    sessions,
    mfaService,
    userEmails,
    audit,
    emailSender,
    { appUrl: TEST_APP_URL },
  );

  return { staffService, staffMembers, customRoles, invitations, sessions, mfaService, mfaCredentials, stepUps, userEmails, auditRepo, emailSender };
}

export function createTestApprovalService(staffService: StaffService, mfaService: MfaService) {
  const policies = new InMemoryBusinessApprovalPolicyRepository();
  const requests = new InMemoryStaffApprovalRequestRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForStaff();
  const audit = new AuditService(auditRepo);
  const approvalService = new ApprovalService(policies, requests, staffService, mfaService, audit);
  return { approvalService, policies, requests, auditRepo };
}

/** Test-only helper: grants a fresh step-up for (userId, sessionId) without going through the real challenge flow. */
export async function grantStepUp(
  fakes: Pick<ReturnType<typeof createTestStaffService>, "mfaCredentials" | "stepUps">,
  userId: string,
  sessionId: string,
): Promise<void> {
  const credential = await fakes.mfaCredentials.insert({ userId, method: "totp", secretRef: "test-secret", phoneRef: null });
  await fakes.mfaCredentials.markVerified(credential.id);
  await fakes.stepUps.insert({ sessionId, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
}
