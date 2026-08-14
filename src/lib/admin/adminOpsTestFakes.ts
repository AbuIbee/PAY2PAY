import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import type { PlatformRole } from "@/lib/auth/authService";
import type { ProfileKind, VerificationState } from "@/lib/profiles/verificationService";
import type { LedgerAccountType, LedgerPostingDirection, LedgerJournalEntryRecord } from "@/lib/ledger/ledgerService";
import { AdminRoleService } from "./adminRoleService";
import type { AdminRoleAssignmentRecord, AdminRoleAssignmentRepository } from "./adminRoleService";
import type { InternalAdminRole } from "./adminCapabilities";
import { RetentionHoldService } from "./retentionHoldService";
import type { RetentionHoldRecord, RetentionHoldRepository, RetentionHoldType } from "./retentionHoldService";
import { AdminRestrictionService } from "./adminRestrictionService";
import type { AdminRestrictionRecord, AdminRestrictionRepository, AdminRestrictionType } from "./adminRestrictionService";
import { SupportCaseService } from "./supportCaseService";
import type { SupportCaseRecord, SupportCaseRepository, SupportCaseStatus } from "./supportCaseService";
import { AppealService } from "./appealService";
import type { AppealDecision, AppealRecord, AppealRepository, AppealStatus, LedgerAdjustmentPoster } from "./appealService";
import { AdminCaseReviewService } from "./adminCaseReviewService";
import type { AdminDisputeReader, VerificationStatusReader } from "./adminCaseReviewService";
import type { AgreementDisputeRecord } from "@/lib/disputes/agreementDisputeService";
import type { PaymentDisputeRecord } from "@/lib/disputes/paymentDisputeService";

/** Test-only in-memory doubles for the Sprint 18 admin/support/appeals architecture, mirroring src/lib/relationships/testFakes.ts's pattern. */

class InMemoryAuditEventRepositoryForAdminOps implements AuditEventRepository {
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

export class InMemoryAdminRoleAssignmentRepository implements AdminRoleAssignmentRepository {
  byId = new Map<string, AdminRoleAssignmentRecord>();

  async insert(input: { userId: string; role: InternalAdminRole; assignedByUserId: string }): Promise<AdminRoleAssignmentRecord> {
    const record: AdminRoleAssignmentRecord = { id: randomUUID(), assignedAt: new Date(), revokedByUserId: null, revokedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findActiveForUser(userId: string): Promise<AdminRoleAssignmentRecord | null> {
    return [...this.byId.values()].find((r) => r.userId === userId && r.revokedAt === null) ?? null;
  }

  async findById(id: string): Promise<AdminRoleAssignmentRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async markRevoked(id: string, revokedByUserId: string, revokedAt: Date): Promise<AdminRoleAssignmentRecord> {
    const record = this.mustFind(id);
    record.revokedByUserId = revokedByUserId;
    record.revokedAt = revokedAt;
    return record;
  }

  private mustFind(id: string): AdminRoleAssignmentRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("admin_role_assignment not found");
    return record;
  }
}

export class InMemoryRetentionHoldRepository implements RetentionHoldRepository {
  byId = new Map<string, RetentionHoldRecord>();

  async insert(input: { targetResourceType: string; targetResourceId: string; holdType: RetentionHoldType; reason: string; placedByUserId: string }): Promise<RetentionHoldRecord> {
    const record: RetentionHoldRecord = { id: randomUUID(), placedAt: new Date(), releasedByUserId: null, releasedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<RetentionHoldRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForTarget(targetResourceType: string, targetResourceId: string): Promise<RetentionHoldRecord[]> {
    return [...this.byId.values()].filter((h) => h.targetResourceType === targetResourceType && h.targetResourceId === targetResourceId);
  }

  async listActive(): Promise<RetentionHoldRecord[]> {
    return [...this.byId.values()].filter((h) => h.releasedAt === null);
  }

  async markReleased(id: string, releasedByUserId: string, releasedAt: Date): Promise<RetentionHoldRecord> {
    const record = this.mustFind(id);
    record.releasedByUserId = releasedByUserId;
    record.releasedAt = releasedAt;
    return record;
  }

  private mustFind(id: string): RetentionHoldRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("retention_hold not found");
    return record;
  }
}

export class InMemoryAdminRestrictionRepository implements AdminRestrictionRepository {
  byId = new Map<string, AdminRestrictionRecord>();

  async insert(input: {
    restrictionType: AdminRestrictionType;
    targetResourceType: string;
    targetResourceId: string;
    reason: string;
    caseReference: string | null;
    placedByUserId: string;
  }): Promise<AdminRestrictionRecord> {
    const record: AdminRestrictionRecord = { id: randomUUID(), placedAt: new Date(), liftedByUserId: null, liftedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AdminRestrictionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findActive(targetResourceType: string, targetResourceId: string, restrictionType: AdminRestrictionType): Promise<AdminRestrictionRecord | null> {
    return (
      [...this.byId.values()].find(
        (r) => r.targetResourceType === targetResourceType && r.targetResourceId === targetResourceId && r.restrictionType === restrictionType && r.liftedAt === null,
      ) ?? null
    );
  }

  async listForTarget(targetResourceType: string, targetResourceId: string): Promise<AdminRestrictionRecord[]> {
    return [...this.byId.values()].filter((r) => r.targetResourceType === targetResourceType && r.targetResourceId === targetResourceId);
  }

  async markLifted(id: string, liftedByUserId: string, liftedAt: Date): Promise<AdminRestrictionRecord> {
    const record = this.mustFind(id);
    record.liftedByUserId = liftedByUserId;
    record.liftedAt = liftedAt;
    return record;
  }

  private mustFind(id: string): AdminRestrictionRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("admin_restriction not found");
    return record;
  }
}

export class InMemorySupportCaseRepository implements SupportCaseRepository {
  byId = new Map<string, SupportCaseRecord>();

  async insert(input: { subjectUserId: string; openedByUserId: string | null; category: string | null; summary: string }): Promise<SupportCaseRecord> {
    const now = new Date();
    const record: SupportCaseRecord = { id: randomUUID(), status: "open", resolutionNotes: null, createdAt: now, updatedAt: now, resolvedAt: null, closedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<SupportCaseRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForUser(subjectUserId: string): Promise<SupportCaseRecord[]> {
    return [...this.byId.values()].filter((c) => c.subjectUserId === subjectUserId);
  }

  async listOpen(): Promise<SupportCaseRecord[]> {
    return [...this.byId.values()].filter((c) => c.status !== "closed" && c.status !== "resolved");
  }

  async updateStatus(id: string, status: SupportCaseStatus, resolutionNotes: string | null): Promise<SupportCaseRecord> {
    const record = this.mustFind(id);
    record.status = status;
    record.resolutionNotes = resolutionNotes;
    record.updatedAt = new Date();
    if (status === "resolved") record.resolvedAt = new Date();
    if (status === "closed") record.closedAt = new Date();
    return record;
  }

  private mustFind(id: string): SupportCaseRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("support_case not found");
    return record;
  }
}

export class InMemoryAppealRepository implements AppealRepository {
  byId = new Map<string, AppealRecord>();

  async insert(input: {
    appealingUserId: string;
    targetResourceType: string;
    targetResourceId: string;
    originalDecisionSummary: string;
    originalDecisionByUserId: string | null;
    evidenceDescription: string | null;
  }): Promise<AppealRecord> {
    const now = new Date();
    const record: AppealRecord = {
      id: randomUUID(),
      status: "submitted",
      reviewerUserId: null,
      decision: null,
      rationale: null,
      decidedAt: null,
      notifiedAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AppealRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForUser(appealingUserId: string): Promise<AppealRecord[]> {
    return [...this.byId.values()].filter((a) => a.appealingUserId === appealingUserId);
  }

  async listOpen(): Promise<AppealRecord[]> {
    return [...this.byId.values()].filter((a) => a.status !== "decided");
  }

  async assignReviewer(id: string, reviewerUserId: string): Promise<AppealRecord> {
    const record = this.mustFind(id);
    record.reviewerUserId = reviewerUserId;
    record.status = "under_review" as AppealStatus;
    record.updatedAt = new Date();
    return record;
  }

  async recordDecision(id: string, input: { decision: AppealDecision; rationale: string; decidedAt: Date }): Promise<AppealRecord> {
    const record = this.mustFind(id);
    record.status = "decided";
    record.decision = input.decision;
    record.rationale = input.rationale;
    record.decidedAt = input.decidedAt;
    record.updatedAt = new Date();
    return record;
  }

  async markNotified(id: string, notifiedAt: Date): Promise<AppealRecord> {
    const record = this.mustFind(id);
    record.notifiedAt = notifiedAt;
    record.updatedAt = new Date();
    return record;
  }

  private mustFind(id: string): AppealRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("appeal not found");
    return record;
  }
}

export class InMemoryVerificationStatusReader implements VerificationStatusReader {
  states = new Map<string, VerificationState>(); // `${kind}:${id}` -> state

  set(profileKind: ProfileKind, profileId: string, state: VerificationState): void {
    this.states.set(`${profileKind}:${profileId}`, state);
  }

  async getVerificationState(profileKind: ProfileKind, profileId: string): Promise<VerificationState> {
    return this.states.get(`${profileKind}:${profileId}`) ?? "UNVERIFIED";
  }
}

export class InMemoryAdminDisputeReader implements AdminDisputeReader {
  agreementDisputes = new Map<string, AgreementDisputeRecord>();
  paymentDisputes = new Map<string, PaymentDisputeRecord>();

  async findAgreementDisputeById(id: string): Promise<AgreementDisputeRecord | null> {
    return this.agreementDisputes.get(id) ?? null;
  }

  async findPaymentDisputeById(id: string): Promise<PaymentDisputeRecord | null> {
    return this.paymentDisputes.get(id) ?? null;
  }
}

/** Fake ledger-adjustment poster — mirrors relationships/testFakes.ts's InMemoryMandateReader precedent of a fake connector that records calls without depending on the real LedgerAdminService, keeping the Owner-only gate explicit and inspectable. */
export class InMemoryLedgerAdjustmentPoster implements LedgerAdjustmentPoster {
  posted: { actingRole: PlatformRole; actingUserId: string; input: unknown }[] = [];

  async postAdjustment(
    actingRole: PlatformRole,
    actingUserId: string,
    input: {
      paymentAttemptId: string;
      agreementId: string;
      currency: string;
      targetAccountType: Exclude<LedgerAccountType, "admin_adjustment_suspense">;
      direction: LedgerPostingDirection;
      amountMinorUnits: number;
      reason: string;
    },
  ): Promise<LedgerJournalEntryRecord> {
    if (actingRole !== "platform_owner") {
      throw new Error("Platform Owner access is required to post a ledger adjustment.");
    }
    this.posted.push({ actingRole, actingUserId, input });
    return {
      id: randomUUID(),
      agreementId: input.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      entryType: "admin_adjustment",
      currency: input.currency,
      createdAt: new Date(),
    } as LedgerJournalEntryRecord;
  }
}

/** Full Sprint 18 admin/support/appeals test harness — every service sharing the same underlying AdminRoleService/AuditService instances a real request would. */
export function createTestAdminOpsServices() {
  const roleAssignments = new InMemoryAdminRoleAssignmentRepository();
  const roleAuditRepo = new InMemoryAuditEventRepositoryForAdminOps();
  const adminRoleService = new AdminRoleService({ assignments: roleAssignments, audit: new AuditService(roleAuditRepo) });

  const holds = new InMemoryRetentionHoldRepository();
  const holdAuditRepo = new InMemoryAuditEventRepositoryForAdminOps();
  const retentionHoldService = new RetentionHoldService({ holds, roles: adminRoleService, audit: new AuditService(holdAuditRepo) });

  const restrictions = new InMemoryAdminRestrictionRepository();
  const restrictionAuditRepo = new InMemoryAuditEventRepositoryForAdminOps();
  const adminRestrictionService = new AdminRestrictionService({ restrictions, roles: adminRoleService, audit: new AuditService(restrictionAuditRepo) });

  const cases = new InMemorySupportCaseRepository();
  const caseAuditRepo = new InMemoryAuditEventRepositoryForAdminOps();
  const supportCaseService = new SupportCaseService({ cases, roles: adminRoleService, audit: new AuditService(caseAuditRepo) });

  const appeals = new InMemoryAppealRepository();
  const appealAuditRepo = new InMemoryAuditEventRepositoryForAdminOps();
  const ledger = new InMemoryLedgerAdjustmentPoster();
  const notifyCtx = createTestNotificationService();
  const appealService = new AppealService({
    appeals,
    roles: adminRoleService,
    restrictions: adminRestrictionService,
    ledger,
    notifications: notifyCtx.notificationService,
    audit: new AuditService(appealAuditRepo),
  });

  const verification = new InMemoryVerificationStatusReader();
  const disputes = new InMemoryAdminDisputeReader();
  const auditReader = { listForTarget: async (targetResourceType: string, targetResourceId: string) => [...roleAuditRepo.events, ...holdAuditRepo.events, ...restrictionAuditRepo.events, ...caseAuditRepo.events, ...appealAuditRepo.events].filter((e) => e.targetResourceType === targetResourceType && e.targetResourceId === targetResourceId) };
  const adminCaseReviewService = new AdminCaseReviewService({ roles: adminRoleService, verification, disputes, auditReader });

  return {
    roleAssignments,
    adminRoleService,
    holds,
    retentionHoldService,
    restrictions,
    adminRestrictionService,
    cases,
    supportCaseService,
    appeals,
    ledger,
    notifyCtx,
    appealService,
    verification,
    disputes,
    adminCaseReviewService,
  };
}
