import { randomUUID } from "node:crypto";
import { generateRelationshipReferenceCode } from "@/lib/auth/token";
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
import { createTestRiskEventService } from "@/lib/risk/testFakes";
import type { PartyRole } from "@/lib/agreements/agreementService";
import { RelationshipService } from "./relationshipService";
import type {
  AgreementRelationshipLinker,
  CardMethodReader,
  MandateReader,
  RelationshipPairResolver,
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
  BankAccountSubtype,
  FinancialAccountRecord,
  FinancialAccountRepository,
  FinancialAccountType,
  FinancialAccountUsage,
  RelationshipCurrentAgreementRoleReader,
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
      publicReference: generateRelationshipReferenceCode(),
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

  async setPublicReference(id: string, publicReference: string): Promise<RelationshipRecord> {
    const record = this.mustFind(id);
    record.publicReference = publicReference;
    record.updatedAt = new Date();
    return record;
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

/**
 * Test-only in-memory double for `RelationshipPairResolver` (see that interface's own doc comment in
 * relationshipService.ts). Mirrors `DrizzleRelationshipPairResolver`'s real matching/reuse/create
 * semantics against the same shared `InMemoryRelationshipRepository`/`InMemoryRelationshipParticipantRepository`
 * instances the rest of a `createTestRelationshipServices()` harness uses, and serializes concurrent
 * calls for the same unordered party pair with a real promise-chain lock (not just a stub) — so a
 * `Promise.all` of two concurrent `resolveForExactParties` calls for the same pair genuinely exercises
 * the "no duplicate relationship" guarantee, the same way the real advisory lock does.
 */
export class InMemoryRelationshipPairResolver implements RelationshipPairResolver {
  private locks = new Map<string, Promise<void>>();

  constructor(
    private readonly relationships: InMemoryRelationshipRepository,
    private readonly participants: InMemoryRelationshipParticipantRepository,
  ) {}

  async resolveForExactParties(input: {
    creditor: PartyRef;
    creditorUserId: string;
    debtor: PartyRef;
    debtorUserId: string;
    initiatorUserId: string;
  }): Promise<{ relationshipId: string }> {
    const key = [`${input.creditor.kind}:${input.creditor.id}`, `${input.debtor.kind}:${input.debtor.id}`].sort().join("|");
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, previous.then(() => current));
    await previous;
    try {
      return await this.resolveLocked(input);
    } finally {
      release();
    }
  }

  private async resolveLocked(input: {
    creditor: PartyRef;
    creditorUserId: string;
    debtor: PartyRef;
    debtorUserId: string;
    initiatorUserId: string;
  }): Promise<{ relationshipId: string }> {
    // Decision 1 (reversed-role safety): identity-only matching, deliberately ignoring stored role —
    // see DrizzleRelationshipPairResolver's own doc comment for why. Decision 2 (canonical
    // connection): current_agreement_id is no longer part of "is this candidate reusable" — only a
    // terminal relationship status excludes it.
    const TERMINAL_STATUSES: RelationshipStatus[] = ["restricted", "suspended", "closed", "cancelled"];
    const matches = (party: PartyRef, p: RelationshipParticipantRecord) =>
      party.kind === "personal" ? p.individualProfileId === party.id : p.organizationId === party.id;

    const candidate = this.participants.rows
      .filter((p) => p.status === "active" && matches(input.creditor, p))
      .map((p) => this.relationships.byId.get(p.relationshipId))
      .filter((r): r is RelationshipRecord => !!r && !TERMINAL_STATUSES.includes(r.status))
      .find((r) =>
        this.participants.rows.some((p) => p.relationshipId === r.id && p.status === "active" && matches(input.debtor, p)),
      );

    if (candidate) return { relationshipId: candidate.id };

    const relationship = await this.relationships.insert({ initiatorUserId: input.initiatorUserId });
    await this.participants.insert({
      relationshipId: relationship.id,
      individualProfileId: input.creditor.kind === "personal" ? input.creditor.id : null,
      organizationId: input.creditor.kind === "business" ? input.creditor.id : null,
      role: "creditor",
      status: "active",
      representedByUserId: input.creditorUserId,
      joinedAt: new Date(),
    });
    await this.participants.insert({
      relationshipId: relationship.id,
      individualProfileId: input.debtor.kind === "personal" ? input.debtor.id : null,
      organizationId: input.debtor.kind === "business" ? input.debtor.id : null,
      role: "debtor",
      status: "active",
      representedByUserId: input.debtorUserId,
      joinedAt: new Date(),
    });
    return { relationshipId: relationship.id };
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

  async findPendingForInvitee(userId: string): Promise<RelationshipInvitationRecord[]> {
    return [...this.byId.values()].filter(
      (i) => i.resolvedInviteeUserId === userId && (i.status === "sent" || i.status === "viewed"),
    );
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

  /**
   * PRSprint 31: synchronous, no-await-before-write — mirrors a real DB's atomic
   * `UPDATE ... WHERE status IN (...)` (see DrizzleRelationshipInvitationRepository.setStatusGuarded's
   * identical doc comment). Returns `null`, never throws, if another decision already won the race.
   */
  private setStatusGuarded(
    id: string,
    status: RelationshipInvitationStatus,
    timestampField: "acceptedAt" | "declinedAt" | "cancelledAt",
  ): RelationshipInvitationRecord | null {
    const record = this.mustFind(id);
    if (record.status !== "sent" && record.status !== "viewed") return null;
    record.status = status;
    record[timestampField] = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async markAccepted(id: string): Promise<RelationshipInvitationRecord | null> {
    return this.setStatusGuarded(id, "accepted", "acceptedAt");
  }

  async markDeclined(id: string): Promise<RelationshipInvitationRecord | null> {
    return this.setStatusGuarded(id, "declined", "declinedAt");
  }

  async markCancelled(id: string): Promise<RelationshipInvitationRecord | null> {
    return this.setStatusGuarded(id, "cancelled", "cancelledAt");
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

/**
 * Decision 1 (reversed-role safety): test-only in-memory double for `RelationshipCurrentAgreementRoleReader`
 * — mirrors `DrizzleRelationshipCurrentAgreementRoleReader`'s real logic against the shared
 * `InMemoryRelationshipRepository`/`AgreementService` instances a `createTestRelationshipServices()`
 * harness already uses.
 */
export class InMemoryRelationshipCurrentAgreementRoleReader implements RelationshipCurrentAgreementRoleReader {
  constructor(
    private readonly relationships: InMemoryRelationshipRepository,
    private readonly agreementService: AgreementService,
  ) {}

  async getCurrentAgreementRoles(relationshipId: string): Promise<{ creditor: PartyRef; debtor: PartyRef } | null> {
    const relationship = await this.relationships.findById(relationshipId);
    if (!relationship?.currentAgreementId) return null;
    try {
      const { agreement } = await this.agreementService.getAgreement(relationship.currentAgreementId, relationship.initiatorUserId);
      return {
        creditor: { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId },
        debtor: { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId },
      };
    } catch {
      return null;
    }
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
    bankAccountSubtype: BankAccountSubtype | null;
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
    id?: string;
    relationshipId: string;
    relationshipParticipantId: string;
    financialAccountId: string;
    usage: FinancialAccountUsage;
    selectedByUserId: string;
  }): Promise<RelationshipFinancialAccountAssignmentRecord> {
    // SPRINT_19_FraudRisk_SecurityHardening: mirrors the real DB's
    // `relationship_financial_account_active_slot_unique` partial unique index (src/db/schema/
    // financialAccount.ts) — only one *active* row may exist per (relationshipId, usage) — so a
    // `Promise.all`-based concurrency test against this fake proves the same conflict-handling path
    // RelationshipFinancialAccountService.replaceAccount exercises against the real database.
    const alreadyActive = [...this.byId.values()].some(
      (a) => a.relationshipId === input.relationshipId && a.usage === input.usage && a.status === "active",
    );
    if (alreadyActive) {
      throw new Error("duplicate key value violates unique constraint \"relationship_financial_account_active_slot_unique\"");
    }
    const now = new Date();
    const { id, ...rest } = input;
    const record: RelationshipFinancialAccountAssignmentRecord = {
      id: id ?? randomUUID(),
      status: "active",
      effectiveFrom: now,
      effectiveTo: null,
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
      ...rest,
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

  async listActiveAssignmentsForAccount(financialAccountId: string): Promise<RelationshipFinancialAccountAssignmentRecord[]> {
    return [...this.byId.values()].filter((a) => a.financialAccountId === financialAccountId && a.status === "active");
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

/**
 * `agreements` is optional so every pre-existing call site (which only ever inspected `.linked`
 * directly) keeps compiling unchanged. When provided, mirrors `DrizzleAgreementRelationshipLinker`'s
 * real behavior more faithfully than the bare `.linked` map alone — it also writes `relationship_id`
 * back onto the actual in-memory `agreement` record, so a later `AgreementService.getAgreement` read
 * (e.g. `RelationshipService.establishAgreementRelationship`'s own idempotency short-circuit) sees the
 * same already-linked state a real database read would.
 */
export class InMemoryAgreementRelationshipLinker implements AgreementRelationshipLinker {
  linked = new Map<string, string>(); // agreementId -> relationshipId

  constructor(private readonly agreements?: InMemoryAgreementRepository) {}

  async linkRelationship(agreementId: string, relationshipId: string): Promise<void> {
    this.linked.set(agreementId, relationshipId);
    const record = this.agreements?.byId.get(agreementId);
    if (record) record.relationshipId = relationshipId;
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
export function createTestRelationshipServices(appUrl: string = "https://app.test") {
  const profileOwners = new InMemoryProfileOwnerReader();
  const staffCtx = createTestStaffService();
  const notifyCtx = createTestNotificationService(undefined, appUrl);
  const riskCtx = createTestRiskEventService();

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
  const agreementLinker = new InMemoryAgreementRelationshipLinker(agreements);
  const pairResolver = new InMemoryRelationshipPairResolver(relationships, participants);
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

  // current_agreement_id / relationship_participant.role audit (item 3): built before
  // relationshipService so getRelationship's own effectiveRole resolution shares the identical
  // instance RelationshipFinancialAccountService already uses — one source of truth in tests, exactly
  // as production shares one DrizzleRelationshipCurrentAgreementRoleReader-shaped read via
  // getAgreementService()/getRelationshipService().
  const agreementRoles = new InMemoryRelationshipCurrentAgreementRoleReader(relationships, agreementService);

  const relationshipAuditRepo = new InMemoryAuditEventRepositoryForRelationships();
  const relationshipService = new RelationshipService({
    relationships,
    participants,
    financialAccounts: assignments,
    agreementService,
    agreements: agreementLinker,
    pairResolver,
    mandates,
    cards,
    evidence: evidenceService,
    profileOwners,
    staffService: staffCtx.staffService,
    notifications: notifyCtx.notificationService,
    audit: new AuditService(relationshipAuditRepo),
    agreementRoles,
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
    appUrl,
  });

  const financialAccountAuditRepo = new InMemoryAuditEventRepositoryForRelationships();
  const relationshipFinancialAccountService = new RelationshipFinancialAccountService({
    financialAccounts,
    assignments,
    relationships,
    participants,
    relationshipSync: relationshipService,
    agreementRoles,
    profileOwners,
    staffService: staffCtx.staffService,
    notifications: notifyCtx.notificationService,
    audit: new AuditService(financialAccountAuditRepo),
    mfa: staffCtx.mfaService,
    riskEvents: riskCtx.riskEventService,
  });

  return {
    profileOwners,
    staffCtx,
    notifyCtx,
    riskCtx,
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
    pairResolver,
    mandates,
    cards,
    evidenceService,
    evidenceRepo,
    witnessRepo,
    emailSender,
    relationshipService,
    relationshipInvitationService,
    relationshipFinancialAccountService,
    agreementRoles,
  };
}
