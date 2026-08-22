import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { AdminRoleService } from "@/lib/admin/adminRoleService";
import type { AdminRoleAssignmentRecord, AdminRoleAssignmentRepository } from "@/lib/admin/adminRoleService";
import type { InternalAdminRole } from "@/lib/admin/adminCapabilities";
import {
  RiskEventService,
  type RiskEventRecord,
  type RiskEventRepository,
  type RiskSignalOutcome,
  type RiskSignalSeverity,
  type RiskSignalType,
} from "./riskEventService";

/** Minimal in-memory AdminRoleService double, mirroring adminOpsTestFakes.ts's identical fake — kept local to avoid a cross-domain import cycle (admin -> risk would be the wrong direction; risk -> admin, used only in tests, is fine). */
class InMemoryAdminRoleAssignmentRepository implements AdminRoleAssignmentRepository {
  private byId = new Map<string, AdminRoleAssignmentRecord>();

  async insert(input: { userId: string; role: InternalAdminRole; assignedByUserId: string }): Promise<AdminRoleAssignmentRecord> {
    const record: AdminRoleAssignmentRecord = { id: randomUUID(), revokedAt: null, revokedByUserId: null, assignedAt: new Date(), ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findActiveForUser(userId: string): Promise<AdminRoleAssignmentRecord | null> {
    return [...this.byId.values()].find((r) => r.userId === userId && !r.revokedAt) ?? null;
  }

  async findById(id: string): Promise<AdminRoleAssignmentRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async markRevoked(id: string, revokedByUserId: string, revokedAt: Date): Promise<AdminRoleAssignmentRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("admin_role_assignment not found");
    record.revokedAt = revokedAt;
    record.revokedByUserId = revokedByUserId;
    return record;
  }
}

class InMemoryAuditEventRepositoryForRisk implements AuditEventRepository {
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

function createTestAdminRoleServiceForRisk() {
  return new AdminRoleService({ assignments: new InMemoryAdminRoleAssignmentRepository(), audit: new AuditService(new InMemoryAuditEventRepositoryForRisk()) });
}

/** Test-only in-memory double for RiskEventService, mirroring src/lib/compliance/testFakes.ts's pattern. */
export class InMemoryRiskEventRepository implements RiskEventRepository {
  events: RiskEventRecord[] = [];

  async insert(input: {
    userId: string;
    signalType: RiskSignalType;
    severity: RiskSignalSeverity;
    outcome: RiskSignalOutcome;
    relatedResourceType: string | null;
    relatedResourceId: string | null;
    detail: Record<string, unknown> | null;
  }): Promise<RiskEventRecord> {
    const record: RiskEventRecord = {
      id: randomUUID(),
      ...input,
      createdAt: new Date(),
      reviewState: "open",
      reviewedByUserId: null,
      reviewedAt: null,
    };
    this.events.push(record);
    return record;
  }

  async findById(id: string): Promise<RiskEventRecord | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  async listForUser(userId: string): Promise<RiskEventRecord[]> {
    return this.events.filter((e) => e.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listRecent(input: { openOnly: boolean; limit: number }): Promise<RiskEventRecord[]> {
    const filtered = input.openOnly ? this.events.filter((e) => e.reviewState === "open") : this.events;
    return [...filtered].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, input.limit);
  }

  async markReviewed(id: string, reviewedByUserId: string, reviewState: "reviewed" | "dismissed"): Promise<RiskEventRecord> {
    const record = this.events.find((e) => e.id === id);
    if (!record) throw new Error("risk_event not found");
    record.reviewState = reviewState;
    record.reviewedByUserId = reviewedByUserId;
    record.reviewedAt = new Date();
    return record;
  }
}

export function createTestRiskEventService() {
  const riskEvents = new InMemoryRiskEventRepository();
  const adminRoleService = createTestAdminRoleServiceForRisk();
  const riskEventService = new RiskEventService({ riskEvents, roles: adminRoleService });
  return { riskEventService, riskEvents, adminRoleService };
}
