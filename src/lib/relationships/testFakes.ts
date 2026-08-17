import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { AgreementService } from "@/lib/agreements/agreementService";
import {
  InMemoryAgreementRepository,
  InMemoryAgreementVersionRepository,
  InMemoryAgreementPartyRepository,
  InMemoryInstallmentScheduleItemRepository,
  InMemorySigningApplicationRepository,
} from "@/lib/agreements/testFakes";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import { createTestNotificationService, InMemoryEmailSender } from "@/lib/notify/testFakes";
import { EvidenceService } from "@/lib/evidence/evidenceService";
import { InMemoryEvidenceRepository, InMemoryAgreementWitnessRepository } from "@/lib/evidence/testFakes";
import { WitnessReaderAdapter } from "@/lib/evidence/witnessReaderAdapter";
import { BasicFileValidator } from "@/lib/evidence/fileValidator";
import { InMemoryDocumentStorage } from "@/lib/documents/testFakes";
import type { PartyRole } from "@/lib/agreements/agreementService";
import { RelationshipService } from "./relationshipService";
import type {
  AgreementRelationshipLinker,
  CardMethodReader,
  MandateReader,
  RelationshipParticipantRecord,
  RelationshipParticipantRepository,
  RelationshipParticipantStatus,
  RelationshipRecord,
  RelationshipRepository,
  RelationshipStatus,
} from "./relationshipService";
import { RelationshipInvitationService } from "./relationshipInvitationService";
import type {
  PartyRef,
  RelationshipInvitationRecord,
  RelationshipInvitationRepository,
  RelationshipInvitationStatus,
  UserLookupReader,
} from "./relationshipInvitationService";
import { RelationshipFinancialAccountService } from "./relationshipFinancialAccountService";
import type {
  FinancialAccountRecord,
  FinancialAccountRepository,
  FinancialAccountType,
  FinancialAccountUsage,
  RelationshipFinancialAccountAssignmentRecord,
  RelationshipFinancialAccountAssignmentWithAccount,
  RelationshipFinancialAccountRepository,
} from "./relationshipFinancialAccountService";

/** Test-only in-memory doubles for the Sprint 18A relationship architecture, mirroring src/lib/ach/testFakes.ts's pattern. */

export class InMemoryRelationshipRepository implements RelationshipRepository {
  byId = new Map<string, RelationshipRecord>();

  /** Takes the participant repository by reference (constructed first) rather than a module-level shared array, so independent createTestRelationshipServices() harnesses within the same test file never cross-contaminate. */
  constructor(private readonly participants: InMemoryRelationshipParticipantRepository) {}

  async insert(input: { initiatorUserId: string }): Promise<RelationshipRecord> {
    const now = new Date();
    const record: RelationshipRecord = {
      id: randomUUID(),
      status: "invited",
      context: "repayment_agreement",
      initiatorUserId: input.initiatorUserId,
      currentAgreementId: null,
      activatedAt: null,
      restrictedAt: null,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<RelationshipRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForParticipant(individualProfileId: string | null, organizationId: string | null): Promise<RelationshipRecord[]> {
    const ids = new Set<string>();
    for (const p of this.participants.rows) {
      if ((individualProfileId && p.individualProfileId === individualProfileId) || (organizationId && p.organizationId === organizationId)) {
        ids.add(p.relationshipId);
      }
    }
    return [...this.byId.values()].filter((r) => ids.has(r.id));
  }

  async setCurrentAgreementId(id: string, agreementId: string): Promise<RelationshipRecord> {
    const record = this.mustFind(id);
    record.currentAgreementId = agreementId;
    record.updatedAt = new Date();
    return record;
  }

  async updateStatus(id: string, status: RelationshipStatus): Promise<RelationshipRecord> {
    const record = this.mustFind(id);
    record.status = status;
    record.updatedAt = new Date();
    return record;
  }

  async markCounterpartyLinked(id: string): Promise<RelationshipRecord> {
    return this.updateStatus(id, "counterparty_linked");
  }

  async markActivated(id: string): Promise<RelationshipRecord> {
    const record = this.mustFind(id);
    record.status = "active";
    record.activatedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async markRestricted(id: string): Promise<RelationshipRecord> {
    const record = this.mustFind(id);
    record.status = "restricted";
    record.restrictedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async markClosed(id: string): Promise<RelationshipRecord> {
    const record = this.mustFind(id);
    record.status = "closed";
    record.closedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  private mustFind(id: string): RelationshipRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("relationship not found");
    return record;
  }
}

export class InMemoryRelationshipParticipantRepository implements RelationshipParticipantRepository {
  rows: RelationshipParticipantRecord[] = [];

  async insert(input: {
    relationshipId: string;
    individualProfileId: string | null;
    organizationId: string | null;
    role: PartyRole;
    status: RelationshipParticipantStatus;
    representedByUserId: string | null;
    joinedAt: Date | null;
  }): Promise<RelationshipParticipantRecord> {
    const now = new Date();
    const record: RelationshipParticipantRecord = {
      id: randomUUID(),
      leftAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.rows.push(record);
    return record;
  }

  async listForRelationship(relationshipId: string): Promise<RelationshipParticipantRecord[]> {
    return this.rows.filter((p) => p.relationshipId === relationshipId);
  }
}

export class InMemoryRelationshipInvitationRepository implements RelationshipInvitationRepository {
  byId = new Map<string, RelationshipInvitationRecord>();

  async insert(input: {
    relationshipId: string;
    inviterUserId: string;
    inviteeEmail: string;
    inviteeRole: PartyRole;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RelationshipInvitationRecord> {
    const now = new Date();
    const record: RelationshipInvitationRecord = {
      id: randomUUID(),
      status: "sent",
      resolvedInviteeUserId: null,
      createdAt: now,
      viewedAt: null,
      acceptedAt: null,
      declinedAt: null,
      cancelledAt: null,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<RelationshipInvitationRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<RelationshipInvitationRecord | null> {
    return [...this.byId.values()].find((i) => i.tokenHash === tokenHash) ?? null;
  }

  async findByRelationshipId(relationshipId: string): Promise<RelationshipInvitationRecord[]> {
    return [...this.byId.values()].filter((i) => i.relationshipId === relationshipId);
  }

  async setResolvedInviteeUser(id: string, userId: string): Promise<RelationshipInvitationRecord> {
    const record = this.mustFind(id);
    record.resolvedInviteeUserId = userId;
    record.updatedAt = new Date();
    return record;
  }

  async markViewed(id: string): Promise<RelationshipInvitationRecord> {
    return this.setStatus(id, "viewed", "viewedAt");
  }

  async markAccepted(id: string): Promise<RelationshipInvitationRecord> {
    return this.setStatus(id, "accepted", "acceptedAt");
  }

  async markDeclined(id: string): Promise<RelationshipInvitationRecord> {
    return this.setStatus(id, "declined", "declinedAt");
  }

  async markCancelled(id: string): Promise<RelationshipInvitationRecord> {
    return this.setStatus(id, "cancelled", "cancelledAt");
  }

  async markExpired(id: string): Promise<RelationshipInvitationRecord> {
    const record = this.mustFind(id);
    record.status = "expired";
    record.updatedAt = new Date();
    return record;
  }

  async findDueForExpiry(now: Date): Promise<RelationshipInvitationRecord[]> {
    return [...this.byId.values()].filter((i) => (i.status === "sent" || i.status === "viewed") && i.expiresAt.getTime() <= now.getTime());
  }

  private setStatus(
    id: string,
    status: RelationshipInvitationStatus,
    timestampField: "viewedAt" | "acceptedAt" | "declinedAt" | "cancelledAt",
  ): RelationshipInvitationRecord {
    const record = this.mustFind(id);
    record.status = status;
    record[timestampField] = new Date();
    record.updatedAt = new Date();
    return record;
  }

  private mustFind(id: string): RelationshipInvitationRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("relationship_invitation not found");
    return record;
  }
}

export class InMemoryFinancialAccountRepository implements FinancialAccountRepository {
  byId = new Map<string, FinancialAccountRecord>();

  async insert(input: {
    individualProfileId: string | null;
    organizationId: string | null;
    accountType: FinancialAccountType;
    providerName: string;
    providerAccountRef: string;
    maskedLast4: string | null;
    institutionDisplayName: string | null;
    cardExpiryMonth: number | null;
    cardExpiryYear: number | null;
    cardBrand: string | null;
    addedByUserId: string;
  }): Promise<FinancialAccountRecord> {
    const now = new Date();
    const record: FinancialAccountRecord = {
      id: randomUUID(),
      status: "pending_verification",
      createdAt: now,
      verifiedAt: null,
      disabledAt: null,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<FinancialAccountRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForParty(individualProfileId: string | null, organizationId: string | null): Promise<FinancialAccountRecord[]> {
    return [...this.byId.values()].filter(
      (a) => (individualProfileId && a.individualProfileId === individualProfileId) || (organizationId && a.organizationId === organizationId),
    );
  }

  async markVerified(id: string, verifiedAt: Date): Promise<FinancialAccountRecord> {
    const record = this.mustFind(id);
    record.status = "verified";
    record.verifiedAt = verifiedAt;
    record.updatedAt = new Date();
    return record;
  }

  async markFailed(id: string): Promise<FinancialAccountRecord> {
    const record = this.mustFind(id);
    record.status = "failed";
    record.updatedAt = new Date();
    return record;
  }

  async markDisabled(id: string, disabledAt: Date): Promise<FinancialAccountRecord> {
    const record = this.mustFind(id);
    record.status = "disabled";
    record.disabledAt = disabledAt;
    record.updatedAt = new Date();
    return record;
  }

  private mustFind(id: string): FinancialAccountRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("financial_account not found");
    return record;
  }
}

export class InMemoryRelationshipFinancialAccountRepository implements RelationshipFinancialAccountRepository {
  byId = new Map<string, RelationshipFinancialAccountAssignmentRecord>();

  constructor(private readonly accounts: InMemoryFinancialAccountRepository) {}

  async insertAssignment(input: {
    relationshipId: string;
    relationshipParticipantId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
    selectedByUserId: string;
  }): Promise<RelationshipFinancialAccountAssignmentRecord> {
    const now = new Date();
    const record: RelationshipFinancialAccountAssignmentRecord = {
      id: randomUUID(),
      status: "active",
      effectiveFrom: now,
      effectiveTo: null,
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findActiveAssignment(relationshipId: string, usage: FinancialAccountUsage): Promise<RelationshipFinancialAccountAssignmentWithAccount | null> {
    const record = [...this.byId.values()].find((a) => a.relationshipId === relationshipId && a.usage === usage && a.status === "active");
    if (!record) return null;
    return this.withAccount(record);
  }

  async markSuperseded(id: string, supersededBy: string): Promise<RelationshipFinancialAccountAssignmentRecord> {
    const record = this.mustFind(id);
    record.status = "superseded";
    record.supersededBy = supersededBy;
    record.effectiveTo = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async listForRelationship(relationshipId: string): Promise<RelationshipFinancialAccountAssignmentWithAccount[]> {
    return [...this.byId.values()].filter((a) => a.relationshipId === relationshipId).map((a) => this.withAccount(a));
  }

  private withAccount(record: RelationshipFinancialAccountAssignmentRecord): RelationshipFinancialAccountAssignmentWithAccount {
    const account = this.accounts.byId.get(record.financialAccountId);
    if (!account) throw new Error("financial_account not found for assignment");
    return { ...record, financialAccount: account };
  }

  private mustFind(id: string): RelationshipFinancialAccountAssignmentRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("relationship_financial_account not found");
    return record;
  }
}

export class InMemoryUserLookupReader implements UserLookupReader {
  private byEmail = new Map<string, string>();

  set(email: string, userId: string): void {
    this.byEmail.set(email, userId);
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    return this.byEmail.get(email) ?? null;
  }
}

export class InMemoryAgreementRelationshipLinker implements AgreementRelationshipLinker {
  linked = new Map<string, string>(); // agreementId -> relationshipId

  async linkRelationship(agreementId: string, relationshipId: string): Promise<void> {
    this.linked.set(agreementId, relationshipId);
  }
}

/** Fake ACH connector — records authorized mandates by agreementId without depending on the real AchMandateService, keeping the relationship test suite's ACH coupling explicit and inspectable. */
export class InMemoryMandateReader implements MandateReader {
  activeByAgreement = new Map<string, { financialAccountId: string; payer: PartyRef }>();
  failNext = false;

  async isActiveForAgreement(agreementId: string): Promise<boolean> {
    return this.activeByAgreement.has(agreementId);
  }

  async authorizeFromFinancialAccount(input: {
    agreementId: string;
    payer: PartyRef;
    financialAccountId: string;
    bankAccountRef: string;
    actingUserId: string;
  }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated_mandate_authorization_failure");
    }
    this.activeByAgreement.set(input.agreementId, { financialAccountId: input.financialAccountId, payer: input.payer });
  }
}

/** Fake debit-card connector — mirrors InMemoryMandateReader exactly, records registered cards by agreementId without depending on the real DebitCardMethodService. */
export class InMemoryCardMethodReader implements CardMethodReader {
  activeByAgreement = new Map<string, { financialAccountId: string; payer: PartyRef }>();
  failNext = false;

  async isActiveForAgreement(agreementId: string): Promise<boolean> {
    return this.activeByAgreement.has(agreementId);
  }

  async registerFromFinancialAccount(input: {
    agreementId: string;
    payer: PartyRef;
    financialAccountId: string;
    cardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    actingUserId: string;
  }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated_card_registration_failure");
    }
    this.activeByAgreement.set(input.agreementId, { financialAccountId: input.financialAccountId, payer: input.payer });
  }
}

class InMemoryAuditEventRepositoryForRelationships implements AuditEventRepository {
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
 * Full Sprint 18A relationship test harness: RelationshipService + RelationshipInvitationService +
 * RelationshipFinancialAccountService, all sharing one `InMemoryProfileOwnerReader` and one
 * `StaffService` instance (mirrors src/lib/ach/testFakes.ts's `createTestAchServices` precedent of
 * sharing state across services so a party recognized as an owner/staff member by one service is
 * recognized identically by every other) — plus a real, independently-instantiated `AgreementService`
 * wired to the same shared `profileOwners`/`staffService`, so `linkAgreement`/`syncFromAgreement`
 * exercise real Sprint 5 agreement logic rather than a stub.
 */
export function createTestRelationshipServices() {
  const profileOwners = new InMemoryProfileOwnerReader();
  const staffCtx = createTestStaffService();
  const notifyCtx = createTestNotificationService();

  const agreements = new InMemoryAgreementRepository();
  const versions = new InMemoryAgreementVersionRepository();
  const parties = new InMemoryAgreementPartyRepository();
  const scheduleItems = new InMemoryInstallmentScheduleItemRepository();
  const agreementAuditRepo = new InMemoryAuditEventRepositoryForRelationships();
  const agreementService = new AgreementService({
    agreements,
    versions,
    parties,
    scheduleItems,
    profileOwners,
    staffService: staffCtx.staffService,
    audit: new AuditService(agreementAuditRepo),
    signing: new InMemorySigningApplicationRepository(versions, agreements),
  });

  const participants = new InMemoryRelationshipParticipantRepository();
  const relationships = new InMemoryRelationshipRepository(participants);
  const invitations = new InMemoryRelationshipInvitationRepository();
  const financialAccounts = new InMemoryFinancialAccountRepository();
  const assignments = new InMemoryRelationshipFinancialAccountRepository(financialAccounts);
  const users = new InMemoryUserLookupReader();
  const agreementLinker = new InMemoryAgreementRelationshipLinker();
  const mandates = new InMemoryMandateReader();
  const cards = new InMemoryCardMethodReader();
  const emailSender = new InMemoryEmailSender();

  // Document/evidence connector (Phase 25) remediation: a real EvidenceService, sharing this same
  // harness's agreementService/profileOwners/staffService — exactly as production wiring does (both
  // getEvidenceService() and getRelationshipService() ultimately resolve through the same
  // AgreementService), so a party recognized by the relationship harness is recognized identically by
  // evidence's own agreement-party visibility check.
  const evidenceRepo = new InMemoryEvidenceRepository();
  const witnessRepo = new InMemoryAgreementWitnessRepository();
  const evidenceStorage = new InMemoryDocumentStorage();
  const evidenceAuditRepo = new InMemoryAuditEventRepositoryForRelationships();
  const evidenceService = new EvidenceService({
    agreementService,
    evidence: evidenceRepo,
    witnesses: new WitnessReaderAdapter(witnessRepo),
    storage: evidenceStorage,
    fileValidator: new BasicFileValidator(),
    audit: new AuditService(evidenceAuditRepo),
  });

  const relationshipAuditRepo = new InMemoryAuditEventRepositoryForRelationships();
  const relationshipService = new RelationshipService({
    relationships,
    participants,
    financialAccounts: assignments,
    agreementService,
    agreements: agreementLinker,
    mandates,
    cards,
    evidence: evidenceService,
    profileOwners,
    staffService: staffCtx.staffService,
    notifications: notifyCtx.notificationService,
    audit: new AuditService(relationshipAuditRepo),
  });

  const invitationAuditRepo = new InMemoryAuditEventRepositoryForRelationships();
  const relationshipInvitationService = new RelationshipInvitationService({
    relationships,
    participants,
    invitations,
    profileOwners,
    staffService: staffCtx.staffService,
    users,
    notifications: notifyCtx.notificationService,
    emailSender,
    audit: new AuditService(invitationAuditRepo),
    appUrl: "https://app.test",
  });

  const financialAccountAuditRepo = new InMemoryAuditEventRepositoryForRelationships();
  const relationshipFinancialAccountService = new RelationshipFinancialAccountService({
    financialAccounts,
    assignments,
    relationships,
    participants,
    relationshipSync: relationshipService,
    profileOwners,
    staffService: staffCtx.staffService,
    notifications: notifyCtx.notificationService,
    audit: new AuditService(financialAccountAuditRepo),
  });

  return {
    profileOwners,
    staffCtx,
    notifyCtx,
    agreementService,
    agreements,
    versions,
    parties,
    scheduleItems,
    relationships,
    participants,
    invitations,
    financialAccounts,
    assignments,
    users,
    agreementLinker,
    mandates,
    cards,
    evidenceService,
    evidenceRepo,
    witnessRepo,
    emailSender,
    relationshipService,
    relationshipInvitationService,
    relationshipFinancialAccountService,
  };
}
