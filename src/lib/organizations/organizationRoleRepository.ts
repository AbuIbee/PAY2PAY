import "server-only";
import type { PermissionScope } from "./permissionCatalog";

export interface OrganizationRoleRecord {
  id: string;
  organizationId: string;
  displayName: string;
  description: string | null;
  isOwnerRole: boolean;
  isProtected: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationRolePermissionRecord {
  id: string;
  roleId: string;
  permissionKey: string;
  scope: PermissionScope;
  createdAt: Date;
}

/** Real implementation: DrizzleOrganizationRoleRepository. */
export interface OrganizationRoleRepository {
  insertRole(input: {
    organizationId: string;
    displayName: string;
    description: string | null;
    isOwnerRole: boolean;
    isProtected: boolean;
    sortOrder: number;
  }): Promise<OrganizationRoleRecord>;
  findRoleById(id: string): Promise<OrganizationRoleRecord | null>;
  /** Tenant-scoped by construction — see organizationRoles.ts's own doc comment. */
  findRoleForOrganization(organizationId: string, roleId: string): Promise<OrganizationRoleRecord | null>;
  findRoleByOrganizationAndName(organizationId: string, displayName: string): Promise<OrganizationRoleRecord | null>;
  findOwnerRoleForOrganization(organizationId: string): Promise<OrganizationRoleRecord | null>;
  listRolesForOrganization(organizationId: string): Promise<OrganizationRoleRecord[]>;
  renameRole(id: string, displayName: string): Promise<void>;
  updateDescription(id: string, description: string | null): Promise<void>;
  deleteRole(id: string): Promise<void>;

  insertPermission(input: { roleId: string; permissionKey: string; scope: PermissionScope }): Promise<OrganizationRolePermissionRecord>;
  removePermission(roleId: string, permissionKey: string): Promise<void>;
  listPermissionsForRole(roleId: string): Promise<OrganizationRolePermissionRecord[]>;

  /** Active (non-removed) business_staff_member rows currently assigned this role. */
  countActiveMembersForRole(roleId: string): Promise<number>;
  /** Pending business_staff_invitation rows currently assigned this role. */
  countPendingInvitationsForRole(roleId: string): Promise<number>;
  reassignActiveMembers(fromRoleId: string, toRoleId: string): Promise<void>;
  reassignPendingInvitations(fromRoleId: string, toRoleId: string): Promise<void>;
}
