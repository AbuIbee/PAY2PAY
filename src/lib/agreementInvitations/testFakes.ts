import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { AgreementInvitationService } from "./agreementInvitationService";
import type {
  AgreementInvitationProposedTerms,
  AgreementInvitationRecord,
  AgreementInvitationRepository,
  AgreementInvitationStatus,
  ProfileDisplayReader,
  UserEmailReader,
  UserLookupReader,
} from "./agreementInvitationService";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";

/** Test-only in-memory doubles for AgreementInvitationService, mirroring src/lib/relationships/relationshipInvitationService.test.ts's pattern. */

export class InMemoryAgreementInvitationRepository implements AgreementInvitationRepository {
  byId = new Map<string, AgreementInvitationRecord>();
  byTokenHash = new Map<string, string>();

  async insert(input: Parameters<AgreementInvitationRepository["insert"]>[0]): Promise<AgreementInvitationRecord> {
    const now = new Date();
    const record: AgreementInvitationRecord = {
      id: randomUUID(),
      recipientProfileKind: null,
      recipientProfileId: null,
      agreementId: null,
      proposalVersion: 1,
      status: "pending",
      openedAt: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      claimedAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    this.byTokenHash.set(record.tokenHash, record.id);
    return record;
  }

  async findById(id: string): Promise<AgreementInvitationRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<AgreementInvitationRecord | null> {
    const id = this.byTokenHash.get(tokenHash);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async markOpened(id: string, openedAt: Date): Promise<AgreementInvitationRecord> {
    const record = this.require(id);
    if (record.status === "pending") {
      record.status = "viewed";
      record.openedAt = openedAt;
      record.updatedAt = new Date();
    }
    return record;
  }

  async updateProposedTerms(
    id: string,
    input: {
      frequency: DraftTermsInput["frequency"];
      feeAllocation: DraftTermsInput["feeAllocation"];
      proposedTerms: AgreementInvitationProposedTerms;
      message: string | null;
      proposalVersion: number;
    },
  ): Promise<AgreementInvitationRecord> {
    const record = this.require(id);
    Object.assign(record, input, { updatedAt: new Date() });
    return record;
  }

  async bindRecipient(
    id: string,
    input: { recipientUserId: string; recipientProfileKind: ProfileKind; recipientProfileId: string },
  ): Promise<AgreementInvitationRecord> {
    const record = this.require(id);
    Object.assign(record, input, { updatedAt: new Date() });
    return record;
  }

  /** PRSprint 31: synchronous, no-await-before-write — mirrors a real DB's atomic `UPDATE ... WHERE status IN (...)` (see DrizzleAgreementInvitationRepository's identical guarded methods). Returns `null`, never throws, if another decision already won the race. */
  private claimGuarded(id: string, status: "accepted" | "declined" | "revoked", timestampField: "acceptedAt" | "declinedAt" | "revokedAt", timestamp: Date): AgreementInvitationRecord | null {
    const record = this.require(id);
    if (record.status !== "pending" && record.status !== "viewed") return null;
    record.status = status;
    record[timestampField] = timestamp;
    record.updatedAt = new Date();
    return record;
  }

  async claimAcceptance(id: string, acceptedAt: Date): Promise<AgreementInvitationRecord | null> {
    return this.claimGuarded(id, "accepted", "acceptedAt", acceptedAt);
  }

  async attachAcceptedAgreement(id: string, input: { claimedAt: Date; agreementId: string }): Promise<AgreementInvitationRecord> {
    const record = this.require(id);
    Object.assign(record, input, { updatedAt: new Date() });
    return record;
  }

  async markDeclined(id: string, declinedAt: Date): Promise<AgreementInvitationRecord | null> {
    return this.claimGuarded(id, "declined", "declinedAt", declinedAt);
  }

  async markRevoked(id: string, revokedAt: Date): Promise<AgreementInvitationRecord | null> {
    return this.claimGuarded(id, "revoked", "revokedAt", revokedAt);
  }

  async markExpired(id: string): Promise<AgreementInvitationRecord> {
    const record = this.require(id);
    record.status = "expired";
    record.updatedAt = new Date();
    return record;
  }

  async regenerateToken(id: string, tokenHash: string, expiresAt: Date): Promise<AgreementInvitationRecord> {
    const record = this.require(id);
    this.byTokenHash.delete(record.tokenHash);
    record.tokenHash = tokenHash;
    record.expiresAt = expiresAt;
    record.updatedAt = new Date();
    this.byTokenHash.set(tokenHash, record.id);
    return record;
  }

  async findDueForExpiry(now: Date): Promise<AgreementInvitationRecord[]> {
    const openStatuses: AgreementInvitationStatus[] = ["pending", "viewed"];
    return [...this.byId.values()].filter((r) => openStatuses.includes(r.status) && r.expiresAt.getTime() <= now.getTime());
  }

  private require(id: string): AgreementInvitationRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("agreement_invitation not found");
    return record;
  }
}

export class InMemoryUserLookupReader implements UserLookupReader {
  userIdByEmail = new Map<string, string>();

  register(email: string, userId: string): void {
    this.userIdByEmail.set(email.toLowerCase(), userId);
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    return this.userIdByEmail.get(email.toLowerCase()) ?? null;
  }
}

export class InMemoryUserEmailReader implements UserEmailReader {
  emailByUserId = new Map<string, string>();

  register(userId: string, email: string): void {
    this.emailByUserId.set(userId, email.toLowerCase());
  }

  async getEmailByUserId(userId: string): Promise<string | null> {
    return this.emailByUserId.get(userId) ?? null;
  }
}

export class InMemoryProfileDisplayReader implements ProfileDisplayReader {
  names = new Map<string, { displayName: string; businessName: string | null }>();

  register(profileKind: ProfileKind, profileId: string, displayName: string, businessName: string | null = null): void {
    this.names.set(`${profileKind}:${profileId}`, { displayName, businessName });
  }

  async getDisplayName(profileKind: ProfileKind, profileId: string): Promise<{ displayName: string; businessName: string | null }> {
    return this.names.get(`${profileKind}:${profileId}`) ?? { displayName: "A Paid2You member", businessName: null };
  }
}

class InMemoryAuditEventRepositoryForAgreementInvitations implements AuditEventRepository {
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
 * Shares its embedded AgreementService's own `profileOwners`/`staffCtx.staffService` instances —
 * both classes must agree on who owns/staffs which profile for a claim-time `createDraft` call to
 * succeed, exactly as production wires them (both ultimately read the same `business_staff_member`/
 * profile-ownership tables).
 */
export function createTestAgreementInvitationService(appUrl = "https://paid2you.example") {
  const agreementCtx = createTestAgreementService();
  const notificationCtx = createTestNotificationService();
  const invitations = new InMemoryAgreementInvitationRepository();
  const users = new InMemoryUserLookupReader();
  const userEmails = new InMemoryUserEmailReader();
  const profileDisplay = new InMemoryProfileDisplayReader();
  const auditRepo = new InMemoryAuditEventRepositoryForAgreementInvitations();
  const audit = new AuditService(auditRepo);

  const invitationService = new AgreementInvitationService({
    invitations,
    agreements: agreementCtx.agreementService,
    profileOwners: agreementCtx.profileOwners,
    profileDisplay,
    staffService: agreementCtx.staffCtx.staffService,
    users,
    userEmails,
    notifications: notificationCtx.notificationService,
    emailSender: notificationCtx.emailSender,
    smsSender: notificationCtx.smsSender,
    audit,
    appUrl,
  });

  return { invitationService, invitations, agreementCtx, notificationCtx, users, userEmails, profileDisplay, auditRepo };
}
