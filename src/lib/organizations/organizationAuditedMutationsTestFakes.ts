import "server-only";
import type { AuditEventRecord } from "@/lib/audit/auditService";
import { AuditService } from "@/lib/audit/auditService";
import type { AuditEventPayload } from "@/lib/audit/hash";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { BusinessStaffMemberRepository, StaffInvitationRepository } from "@/lib/staff/staffService";
import type { OrganizationAuditedMutations, RolePermissionInput } from "./organizationAuditedMutations";
import type { OrganizationRoleRepository } from "./organizationRoleRepository";
import { isPermissionKey, isScopeSupportedForPermission, type PermissionScope } from "./permissionCatalog";

function validatePermissions(permissions: readonly RolePermissionInput[]): void {
  for (const p of permissions) {
    if (!isPermissionKey(p.permissionKey)) throw new ValidationError(`"${p.permissionKey}" is not a recognized permission.`);
    if (!isScopeSupportedForPermission(p.permissionKey, p.scope)) {
      throw new ValidationError(`The "${p.scope}" scope is not yet supported for "${p.permissionKey}".`);
    }
  }
}

function auditPayload(organizationId: string, actorUserId: string, action: string, newValue: unknown, previousValue: unknown = null): AuditEventPayload {
  return {
    actorUserId,
    actorRole: "business_staff",
    profileKind: "business",
    profileId: organizationId,
    agreementId: null,
    action,
    occurredAt: new Date().toISOString(),
    ipAddress: null,
    deviceInfo: null,
    previousValue,
    newValue,
    reason: null,
    authStrength: null,
    relatedDocumentId: null,
    relatedCaseId: null,
  };
}

/** Test-only in-memory audit sink — `getLastEvent`/`insertEvent` only, matching this codebase's ~30 other minimal audit fakes. */
export class InMemoryOrganizationAuditRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events[this.events.length - 1] ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const row: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(row);
    return row;
  }
}

async function activeProtectedOwnerCount(roles: OrganizationRoleRepository, staffMembers: BusinessStaffMemberRepository, organizationId: string, excludingMembershipId?: string): Promise<number> {
  const members = await staffMembers.listActiveByBusiness(organizationId);
  let count = 0;
  for (const member of members) {
    if (excludingMembershipId && member.id === excludingMembershipId) continue;
    if (!member.roleId) continue;
    const role = await roles.findRoleById(member.roleId);
    if (role?.isOwnerRole) count += 1;
  }
  return count;
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover: the in-memory
 * `OrganizationAuditedMutations` for ordinary unit tests — operates against the SAME
 * `OrganizationRoleRepository`/`BusinessStaffMemberRepository`/`StaffInvitationRepository` fakes the
 * rest of a test's fixture already uses, recording audit events via the ordinary (non-transactional)
 * `AuditService.record` path. Deliberately makes NO claim about real Postgres transactional
 * atomicity — that is proven only by `DrizzleOrganizationAuditedMutations` and its own
 * `.postgres.test.ts`. Mirrors the business-rule validation of `OrganizationRoleService` (duplicate
 * name, protected role, last-Owner) so unit tests exercise the same invariants the real
 * implementation enforces.
 */
export class InMemoryOrganizationAuditedMutations implements OrganizationAuditedMutations {
  constructor(
    private readonly roles: OrganizationRoleRepository,
    private readonly staffMembers: BusinessStaffMemberRepository,
    private readonly invitations: StaffInvitationRepository,
    private readonly audit: AuditService,
  ) {}

  async createRole(input: { organizationId: string; actorUserId: string; displayName: string; description: string | null; permissions: readonly RolePermissionInput[] }) {
    if (!input.displayName.trim()) throw new ValidationError("A role name is required.");
    validatePermissions(input.permissions);

    const existing = await this.roles.findRoleByOrganizationAndName(input.organizationId, input.displayName);
    if (existing) throw new ValidationError(`A role named "${input.displayName}" already exists for this organization.`);

    const role = await this.roles.insertRole({ organizationId: input.organizationId, displayName: input.displayName, description: input.description, isOwnerRole: false, isProtected: false, sortOrder: 100 });
    for (const p of input.permissions) {
      await this.roles.insertPermission({ roleId: role.id, permissionKey: p.permissionKey, scope: p.scope });
    }

    await this.audit.record(auditPayload(input.organizationId, input.actorUserId, "organization_role_created", { roleId: role.id, displayName: role.displayName, permissions: input.permissions }));
    return { id: role.id, displayName: role.displayName };
  }

  async renameRole(input: { organizationId: string; actorUserId: string; roleId: string; displayName: string }): Promise<void> {
    if (!input.displayName.trim()) throw new ValidationError("A role name is required.");
    const role = await this.roles.findRoleForOrganization(input.organizationId, input.roleId);
    if (!role) throw new ValidationError("This role does not belong to this organization.");
    const duplicate = await this.roles.findRoleByOrganizationAndName(input.organizationId, input.displayName);
    if (duplicate && duplicate.id !== role.id) throw new ValidationError(`A role named "${input.displayName}" already exists for this organization.`);

    await this.roles.renameRole(input.roleId, input.displayName);
    await this.audit.record(
      auditPayload(input.organizationId, input.actorUserId, "organization_role_renamed", { roleId: role.id, displayName: input.displayName }, { roleId: role.id, displayName: role.displayName }),
    );
  }

  async changeRolePermission(input: { organizationId: string; actorUserId: string; roleId: string; permissionKey: string; scope: PermissionScope; grant: boolean }): Promise<void> {
    if (input.grant) validatePermissions([{ permissionKey: input.permissionKey, scope: input.scope }]);
    else if (!isPermissionKey(input.permissionKey)) throw new ValidationError(`"${input.permissionKey}" is not a recognized permission.`);

    const role = await this.roles.findRoleForOrganization(input.organizationId, input.roleId);
    if (!role) throw new ValidationError("This role does not belong to this organization.");
    if (role.isProtected) throw new ForbiddenError("This role's permissions are protected and cannot be edited individually.");

    if (input.grant) {
      await this.roles.insertPermission({ roleId: role.id, permissionKey: input.permissionKey, scope: input.scope });
    } else {
      await this.roles.removePermission(role.id, input.permissionKey);
    }

    await this.audit.record(
      auditPayload(input.organizationId, input.actorUserId, "organization_role_permission_changed", { roleId: role.id, permissionKey: input.permissionKey, scope: input.scope, granted: input.grant }),
    );
  }

  async inviteMember(input: { organizationId: string; actorUserId: string; email: string; roleId: string; tokenHash: string; expiresAt: Date }) {
    const role = await this.roles.findRoleForOrganization(input.organizationId, input.roleId);
    if (!role) throw new ValidationError("This role does not belong to this organization.");

    const existingPending = await this.invitations.findPendingByBusinessAndEmail(input.organizationId, input.email);
    if (existingPending) throw new ConflictError("An invitation is already pending for this email address.");

    const invitation = await this.invitations.insert({
      businessProfileId: input.organizationId,
      email: input.email,
      role: "VIEWER",
      customRoleId: null,
      roleId: role.id,
      invitedByUserId: input.actorUserId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });

    await this.audit.record(auditPayload(input.organizationId, input.actorUserId, "organization_member_invited", { email: input.email, roleId: role.id }));
    return { id: invitation.id, email: invitation.email, roleId: invitation.roleId };
  }

  async changeMemberRole(input: { organizationId: string; actorUserId: string; targetMembershipId: string; newRoleId: string }): Promise<void> {
    const target = await this.staffMembers.findById(input.targetMembershipId);
    if (!target || target.businessProfileId !== input.organizationId || target.removedAt) {
      throw new ValidationError("This team member does not belong to this organization.");
    }
    if (target.userId === input.actorUserId) throw new ForbiddenError("You cannot change your own role.");

    const newRole = await this.roles.findRoleForOrganization(input.organizationId, input.newRoleId);
    if (!newRole) throw new ValidationError("This role does not belong to this organization.");

    if (!newRole.isOwnerRole) {
      const currentRole = target.roleId ? await this.roles.findRoleById(target.roleId) : null;
      if (currentRole?.isOwnerRole) {
        const otherOwners = await activeProtectedOwnerCount(this.roles, this.staffMembers, input.organizationId, target.id);
        if (otherOwners === 0) throw new ForbiddenError("This organization must always have at least one Owner — reassign another member to Owner first.");
      }
    }

    await this.staffMembers.setRoleId(target.id, newRole.id);
    await this.audit.record(
      auditPayload(
        input.organizationId,
        input.actorUserId,
        "organization_member_role_changed",
        { targetMembershipId: target.id, targetUserId: target.userId, roleId: newRole.id },
        { roleId: target.roleId },
      ),
    );
  }

  async removeMember(input: { organizationId: string; actorUserId: string; targetMembershipId: string }): Promise<void> {
    const target = await this.staffMembers.findById(input.targetMembershipId);
    if (!target || target.businessProfileId !== input.organizationId || target.removedAt) {
      throw new ValidationError("This team member does not belong to this organization.");
    }
    if (target.userId === input.actorUserId) throw new ForbiddenError("You cannot remove yourself.");

    const currentRole = target.roleId ? await this.roles.findRoleById(target.roleId) : null;
    if (currentRole?.isOwnerRole) {
      const otherOwners = await activeProtectedOwnerCount(this.roles, this.staffMembers, input.organizationId, target.id);
      if (otherOwners === 0) throw new ForbiddenError("The final Owner of an organization cannot be removed.");
    }

    await this.staffMembers.markRemoved(target.id, new Date());
    await this.audit.record(auditPayload(input.organizationId, input.actorUserId, "organization_member_removed", { targetMembershipId: target.id, targetUserId: target.userId, roleId: target.roleId }));
  }
}

export function createTestOrganizationAuditedMutations(roles: OrganizationRoleRepository, staffMembers: BusinessStaffMemberRepository, invitations: StaffInvitationRepository) {
  const auditRepo = new InMemoryOrganizationAuditRepository();
  const audit = new AuditService(auditRepo);
  const mutations = new InMemoryOrganizationAuditedMutations(roles, staffMembers, invitations, audit);
  return { mutations, auditRepo, audit };
}
