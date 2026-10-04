import { randomUUID } from "node:crypto";
import type { OrganizationRoleRecord, OrganizationRolePermissionRecord, OrganizationRoleRepository } from "./organizationRoleRepository";
import { OrganizationRoleService } from "./organizationRoleService";
import type { PermissionScope } from "./permissionCatalog";

/** Test-only in-memory double, mirroring this codebase's established per-domain testFakes pattern. */
export class InMemoryOrganizationRoleRepository implements OrganizationRoleRepository {
  roles = new Map<string, OrganizationRoleRecord>();
  permissions = new Map<string, OrganizationRolePermissionRecord>();
  /** Test-only hooks this file's own tests use to simulate membership/invitation assignment without pulling in the full staff module. */
  activeMembersByRole = new Map<string, Set<string>>();
  pendingInvitationsByRole = new Map<string, Set<string>>();

  async insertRole(input: {
    organizationId: string;
    displayName: string;
    description: string | null;
    isOwnerRole: boolean;
    isProtected: boolean;
    sortOrder: number;
  }): Promise<OrganizationRoleRecord> {
    const record: OrganizationRoleRecord = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...input };
    this.roles.set(record.id, record);
    return record;
  }

  async findRoleById(id: string): Promise<OrganizationRoleRecord | null> {
    return this.roles.get(id) ?? null;
  }

  async findRoleForOrganization(organizationId: string, roleId: string): Promise<OrganizationRoleRecord | null> {
    const role = this.roles.get(roleId);
    if (!role || role.organizationId !== organizationId) return null;
    return role;
  }

  async findRoleByOrganizationAndName(organizationId: string, displayName: string): Promise<OrganizationRoleRecord | null> {
    return [...this.roles.values()].find((r) => r.organizationId === organizationId && r.displayName === displayName) ?? null;
  }

  async findOwnerRoleForOrganization(organizationId: string): Promise<OrganizationRoleRecord | null> {
    return [...this.roles.values()].find((r) => r.organizationId === organizationId && r.isOwnerRole) ?? null;
  }

  async listRolesForOrganization(organizationId: string): Promise<OrganizationRoleRecord[]> {
    return [...this.roles.values()].filter((r) => r.organizationId === organizationId);
  }

  async renameRole(id: string, displayName: string): Promise<void> {
    const role = this.roles.get(id);
    if (role) role.displayName = displayName;
  }

  async updateDescription(id: string, description: string | null): Promise<void> {
    const role = this.roles.get(id);
    if (role) role.description = description;
  }

  async deleteRole(id: string): Promise<void> {
    this.roles.delete(id);
    for (const [permId, perm] of this.permissions) {
      if (perm.roleId === id) this.permissions.delete(permId);
    }
  }

  async insertPermission(input: { roleId: string; permissionKey: string; scope: PermissionScope }): Promise<OrganizationRolePermissionRecord> {
    const record: OrganizationRolePermissionRecord = { id: randomUUID(), createdAt: new Date(), ...input };
    this.permissions.set(record.id, record);
    return record;
  }

  async removePermission(roleId: string, permissionKey: string): Promise<void> {
    for (const [id, perm] of this.permissions) {
      if (perm.roleId === roleId && perm.permissionKey === permissionKey) this.permissions.delete(id);
    }
  }

  async listPermissionsForRole(roleId: string): Promise<OrganizationRolePermissionRecord[]> {
    return [...this.permissions.values()].filter((p) => p.roleId === roleId);
  }

  async countActiveMembersForRole(roleId: string): Promise<number> {
    return this.activeMembersByRole.get(roleId)?.size ?? 0;
  }

  async countPendingInvitationsForRole(roleId: string): Promise<number> {
    return this.pendingInvitationsByRole.get(roleId)?.size ?? 0;
  }

  async reassignActiveMembers(fromRoleId: string, toRoleId: string): Promise<void> {
    const members = this.activeMembersByRole.get(fromRoleId);
    if (!members) return;
    const existingTarget = this.activeMembersByRole.get(toRoleId) ?? new Set<string>();
    for (const m of members) existingTarget.add(m);
    this.activeMembersByRole.set(toRoleId, existingTarget);
    this.activeMembersByRole.delete(fromRoleId);
  }

  async reassignPendingInvitations(fromRoleId: string, toRoleId: string): Promise<void> {
    const invitations = this.pendingInvitationsByRole.get(fromRoleId);
    if (!invitations) return;
    const existingTarget = this.pendingInvitationsByRole.get(toRoleId) ?? new Set<string>();
    for (const i of invitations) existingTarget.add(i);
    this.pendingInvitationsByRole.set(toRoleId, existingTarget);
    this.pendingInvitationsByRole.delete(fromRoleId);
  }
}

export function createTestOrganizationRoleService() {
  const roles = new InMemoryOrganizationRoleRepository();
  const organizationRoleService = new OrganizationRoleService(roles);
  return { organizationRoleService, roles };
}
