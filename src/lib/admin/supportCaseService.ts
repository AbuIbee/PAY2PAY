import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import type { PlatformRole } from "@/lib/auth/authService";
import type { AdminRoleService } from "./adminRoleService";

export type SupportCaseStatus = "open" | "in_review" | "resolved" | "closed";

export interface SupportCaseRecord {
  id: string;
  subjectUserId: string;
  openedByUserId: string | null;
  category: string | null;
  summary: string;
  status: SupportCaseStatus;
  resolutionNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

/** Real implementation: DrizzleSupportCaseRepository. */
export interface SupportCaseRepository {
  insert(input: { subjectUserId: string; openedByUserId: string | null; category: string | null; summary: string }): Promise<SupportCaseRecord>;
  findById(id: string): Promise<SupportCaseRecord | null>;
  listForUser(subjectUserId: string): Promise<SupportCaseRecord[]>;
  listOpen(): Promise<SupportCaseRecord[]>;
  updateStatus(id: string, status: SupportCaseStatus, resolutionNotes: string | null): Promise<SupportCaseRecord>;
}

export interface SupportCaseServiceDeps {
  cases: SupportCaseRepository;
  roles: AdminRoleService;
  audit: AuditService;
}

/** Sprint 18 §29 "Manage support cases" — deliberately minimal: open, move through status, close. No ticketing-system features (SLAs, category taxonomy, queues) this sprint's own file never names. */
export class SupportCaseService {
  constructor(private readonly deps: SupportCaseServiceDeps) {}

  async openCase(input: { subjectUserId: string; category: string | null; summary: string; actingUserId: string; actingRole: PlatformRole }): Promise<SupportCaseRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "manage_support_case");
    if (!input.summary.trim()) throw new ValidationError("A summary is required to open a support case.");
    const record = await this.deps.cases.insert({
      subjectUserId: input.subjectUserId,
      openedByUserId: input.actingUserId,
      category: input.category,
      summary: input.summary,
    });
    await this.recordAudit(record, "support_case_opened", input.actingUserId, null);
    return record;
  }

  async updateStatus(input: { caseId: string; status: SupportCaseStatus; resolutionNotes?: string | null; actingUserId: string; actingRole: PlatformRole }): Promise<SupportCaseRecord> {
    await this.deps.roles.requireCapability(input.actingUserId, input.actingRole, "manage_support_case");
    const existing = await this.requireCase(input.caseId);
    if (existing.status === "closed") {
      throw new ValidationError("This support case is already closed.");
    }
    const updated = await this.deps.cases.updateStatus(existing.id, input.status, input.resolutionNotes ?? existing.resolutionNotes);
    await this.recordAudit(updated, "support_case_status_changed", input.actingUserId, input.resolutionNotes ?? null);
    return updated;
  }

  async closeCase(input: { caseId: string; resolutionNotes: string; actingUserId: string; actingRole: PlatformRole }): Promise<SupportCaseRecord> {
    return this.updateStatus({ caseId: input.caseId, status: "closed", resolutionNotes: input.resolutionNotes, actingUserId: input.actingUserId, actingRole: input.actingRole });
  }

  async getCase(caseId: string, actingUserId: string, actingRole: PlatformRole): Promise<SupportCaseRecord> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "manage_support_case");
    return this.requireCase(caseId);
  }

  async listOpenCases(actingUserId: string, actingRole: PlatformRole): Promise<SupportCaseRecord[]> {
    await this.deps.roles.requireCapability(actingUserId, actingRole, "manage_support_case");
    return this.deps.cases.listOpen();
  }

  private async requireCase(id: string): Promise<SupportCaseRecord> {
    const record = await this.deps.cases.findById(id);
    if (!record) throw new ValidationError("Support case not found.");
    return record;
  }

  private async recordAudit(record: SupportCaseRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "platform_admin",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { status: record.status },
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: record.id,
      targetResourceType: "support_case",
      targetResourceId: record.id,
    });
  }
}
