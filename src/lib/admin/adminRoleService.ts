import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { PlatformRole } from "@/lib/auth/authService";
import { isAdminRole, isOwnerRole } from "./capabilities";
import { ADMIN_CAPABILITIES, DEFAULT_INTERNAL_ROLE_CAPABILITIES } from "./adminCapabilities";
import type { AdminCapability, InternalAdminRole } from "./adminCapabilities";

export interface AdminRoleAssignmentRecord {
  id: string;
  userId: string;
  role: InternalAdminRole;
  assignedByUserId: string;
  assignedAt: Date;
  revokedByUserId: string | null;
  revokedAt: Date | null;
}

/** Real implementation: DrizzleAdminRoleAssignmentRepository. Append-only — `revoke` only ever sets the revocation fields on an existing row, never deletes it, matching every other role/membership table's precedent in this codebase (`business_staff_member.removedAt`, `ach_mandate`'s revocation shape). */
export interface AdminRoleAssignmentRepository {
  insert(input: { userId: string; role: InternalAdminRole; assignedByUserId: string }): Promise<AdminRoleAssignmentRecord>;
  findActiveForUser(userId: string): Promise<AdminRoleAssignmentRecord | null>;
  findById(id: string): Promise<AdminRoleAssignmentRecord | null>;
  markRevoked(id: string, revokedByUserId: string, revokedAt: Date): Promise<AdminRoleAssignmentRecord>;
}

export interface AdminRoleServiceDeps {
  assignments: AdminRoleAssignmentRepository;
  audit: AuditService;
}

/**
 * Sprint 18's internal-admin-role and capability model — every other Sprint 18 service's shared
 * authorization primitive (`requireCapability`). `PlatformRole` (Sprint 6A: member/platform_admin/
 * platform_owner) remains the base gate: a caller must already be at least `platform_admin` before
 * this class even looks at their internal role. A `platform_owner` always passes every capability
 * check, mirroring `isOwnerRole`'s identical bypass precedent used throughout this codebase (Sprint
 * 6A's own `changeUserRole`, Sprint 10's `LedgerAdminService`, etc.) — ownership is not modeled as
 * "has every internal admin role assigned," it structurally bypasses the check instead.
 *
 * Role assignment/revocation is Owner-only, mirroring Sprint 6A's `AdminService.changeUserRole`'s
 * identical gating exactly (assigning who gets which admin powers is exactly as sensitive as changing
 * a platform role in the first place).
 */
export class AdminRoleService {
  constructor(private readonly deps: AdminRoleServiceDeps) {}

  async assignRole(input: { targetUserId: string; role: InternalAdminRole; actingUserId: string; actingRole: PlatformRole; reason: string | null }): Promise<AdminRoleAssignmentRecord> {
    if (!isOwnerRole(input.actingRole)) {
      throw new ForbiddenError("Platform Owner access is required to assign an internal admin role.");
    }
    const existing = await this.deps.assignments.findActiveForUser(input.targetUserId);
    if (existing) {
      throw new ValidationError(`This user already has an active internal admin role ("${existing.role}") — revoke it first.`);
    }
    const record = await this.deps.assignments.insert({
      userId: input.targetUserId,
      role: input.role,
      assignedByUserId: input.actingUserId,
    });
    await this.recordAudit(record, "admin_role_assigned", input.actingUserId, input.reason);
    return record;
  }

  async revokeRole(input: { assignmentId: string; actingUserId: string; actingRole: PlatformRole; reason: string | null }): Promise<AdminRoleAssignmentRecord> {
    if (!isOwnerRole(input.actingRole)) {
      throw new ForbiddenError("Platform Owner access is required to revoke an internal admin role.");
    }
    const assignment = await this.deps.assignments.findById(input.assignmentId);
    if (!assignment) throw new ValidationError("Admin role assignment not found.");
    if (assignment.revokedAt) throw new ValidationError("This admin role assignment has already been revoked.");
    const updated = await this.deps.assignments.markRevoked(assignment.id, input.actingUserId, new Date());
    await this.recordAudit(updated, "admin_role_revoked", input.actingUserId, input.reason);
    return updated;
  }

  async getActiveRole(userId: string): Promise<InternalAdminRole | null> {
    const assignment = await this.deps.assignments.findActiveForUser(userId);
    return assignment?.role ?? null;
  }

  /**
   * The shared gate every other Sprint 18 service calls before acting. Fails closed: a
   * `platform_admin` with no active internal role assignment at all has zero Sprint 18 capabilities
   * (Sprint 6A's own base `platform_admin` grant is not itself treated as "full Sprint 18 access" —
   * an explicit internal role must be assigned).
   */
  async requireCapability(actingUserId: string, actingRole: PlatformRole, capability: AdminCapability): Promise<void> {
    if (!isAdminRole(actingRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    if (isOwnerRole(actingRole)) return;
    const role = await this.getActiveRole(actingUserId);
    if (!role) {
      throw new ForbiddenError("You have no internal admin role assigned.");
    }
    if (role === "admin") return;
    const allowed = DEFAULT_INTERNAL_ROLE_CAPABILITIES[role];
    if (!allowed.includes(capability)) {
      throw new ForbiddenError(`This action requires the "${capability}" capability.`);
    }
  }

  async hasCapability(actingUserId: string, actingRole: PlatformRole, capability: AdminCapability): Promise<boolean> {
    return this.requireCapability(actingUserId, actingRole, capability)
      .then(() => true)
      .catch(() => false);
  }

  private async recordAudit(record: AdminRoleAssignmentRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "platform_owner",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { role: record.role },
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "admin_role_assignment",
      targetResourceId: record.id,
    });
  }
}

export { ADMIN_CAPABILITIES };
export type { AdminCapability, InternalAdminRole };
