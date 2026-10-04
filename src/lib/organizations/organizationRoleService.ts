import "server-only";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { DEFAULT_ROLE_TEMPLATES, ownerPermissionKeys } from "./defaultRoleTemplates";
import type { OrganizationRoleRecord, OrganizationRolePermissionRecord, OrganizationRoleRepository } from "./organizationRoleRepository";
import { isPermissionKey, isScopeSupportedForPermission, type PermissionScope } from "./permissionCatalog";

export interface OrganizationRoleWithPermissions {
  role: OrganizationRoleRecord;
  permissions: OrganizationRolePermissionRecord[];
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Requirement 9/10/13, Section 13: the single
 * authorization-adjacent seam for creating/renaming/describing/deleting organization roles and
 * assigning their permissions. Every protected-Owner invariant lives here, not scattered across
 * route handlers — Requirement 9's "an ordinary role cannot become Owner merely because every
 * checkbox is selected" is enforced structurally: `isOwnerRole` is never set by any method here
 * except `seedDefaultRolesForNewOrganization`'s own one-time Owner creation, and no permission-editing
 * method can ever flip it.
 */
export class OrganizationRoleService {
  constructor(private readonly roles: OrganizationRoleRepository) {}

  /**
   * Called once, atomically alongside organization creation (see AtomicBusinessProfileCreator's own
   * doc comment for why "the organization exists without its Owner" is unacceptable — the same
   * invariant now extends to "the organization exists without its Owner ROLE"). Idempotent: a
   * retried call for an organization that already has an owner role is a no-op, never a duplicate
   * or a thrown ConflictError.
   */
  async seedDefaultRolesForNewOrganization(organizationId: string): Promise<{
    ownerRoleId: string;
    managerRoleId: string;
    employee2RoleId: string;
    employee3RoleId: string;
  }> {
    const existingOwnerRole = await this.roles.findOwnerRoleForOrganization(organizationId);
    if (existingOwnerRole) {
      const existing = await this.roles.listRolesForOrganization(organizationId);
      const manager = existing.find((r) => r.displayName === DEFAULT_ROLE_TEMPLATES.manager.displayName);
      const employee2 = existing.find((r) => r.displayName === DEFAULT_ROLE_TEMPLATES.employee2.displayName);
      const employee3 = existing.find((r) => r.displayName === DEFAULT_ROLE_TEMPLATES.employee3.displayName);
      if (manager && employee2 && employee3) {
        return { ownerRoleId: existingOwnerRole.id, managerRoleId: manager.id, employee2RoleId: employee2.id, employee3RoleId: employee3.id };
      }
    }

    const owner = await this.roles.insertRole({
      organizationId,
      displayName: "Owner",
      description: "Full organization access, including billing, roles, and ownership-recovery rights. This role cannot be deleted.",
      isOwnerRole: true,
      isProtected: true,
      sortOrder: 0,
    });
    for (const key of ownerPermissionKeys()) {
      await this.roles.insertPermission({ roleId: owner.id, permissionKey: key, scope: "organization" });
    }

    const createdTemplateRoleIds: Record<"manager" | "employee2" | "employee3", string> = { manager: "", employee2: "", employee3: "" };
    for (const [templateKey, template] of Object.entries(DEFAULT_ROLE_TEMPLATES) as Array<[keyof typeof DEFAULT_ROLE_TEMPLATES, (typeof DEFAULT_ROLE_TEMPLATES)[keyof typeof DEFAULT_ROLE_TEMPLATES]]>) {
      const role = await this.roles.insertRole({
        organizationId,
        displayName: template.displayName,
        description: template.description,
        isOwnerRole: false,
        isProtected: false,
        sortOrder: template.sortOrder,
      });
      for (const key of template.permissionKeys) {
        await this.roles.insertPermission({ roleId: role.id, permissionKey: key, scope: "organization" });
      }
      createdTemplateRoleIds[templateKey] = role.id;
    }

    return {
      ownerRoleId: owner.id,
      managerRoleId: createdTemplateRoleIds.manager,
      employee2RoleId: createdTemplateRoleIds.employee2,
      employee3RoleId: createdTemplateRoleIds.employee3,
    };
  }

  async listRolesWithPermissions(organizationId: string): Promise<OrganizationRoleWithPermissions[]> {
    const roles = await this.roles.listRolesForOrganization(organizationId);
    const result: OrganizationRoleWithPermissions[] = [];
    for (const role of roles) {
      result.push({ role, permissions: await this.roles.listPermissionsForRole(role.id) });
    }
    return result;
  }

  async createRole(input: {
    organizationId: string;
    displayName: string;
    description: string | null;
    permissions: ReadonlyArray<{ permissionKey: string; scope: PermissionScope }>;
  }): Promise<OrganizationRoleRecord> {
    if (!input.displayName.trim()) throw new ValidationError("A role name is required.");
    const existing = await this.roles.findRoleByOrganizationAndName(input.organizationId, input.displayName);
    if (existing) throw new ValidationError(`A role named "${input.displayName}" already exists for this organization.`);

    this.validatePermissions(input.permissions);

    const role = await this.roles.insertRole({
      organizationId: input.organizationId,
      displayName: input.displayName,
      description: input.description,
      isOwnerRole: false,
      isProtected: false,
      sortOrder: 100,
    });
    for (const p of input.permissions) {
      await this.roles.insertPermission({ roleId: role.id, permissionKey: p.permissionKey, scope: p.scope });
    }
    return role;
  }

  /** Requirement 9: renaming never changes which role IS the owner role, nor its permissions — only its label. */
  async renameRole(organizationId: string, roleId: string, displayName: string): Promise<void> {
    if (!displayName.trim()) throw new ValidationError("A role name is required.");
    const role = await this.requireRoleForOrganization(organizationId, roleId);
    const existing = await this.roles.findRoleByOrganizationAndName(organizationId, displayName);
    if (existing && existing.id !== role.id) throw new ValidationError(`A role named "${displayName}" already exists for this organization.`);
    await this.roles.renameRole(roleId, displayName);
  }

  async updateDescription(organizationId: string, roleId: string, description: string | null): Promise<void> {
    await this.requireRoleForOrganization(organizationId, roleId);
    await this.roles.updateDescription(roleId, description);
  }

  /** Requirement 9: a protected role's permission set may never be edited away from "complete" one checkbox at a time. */
  async assignPermission(organizationId: string, roleId: string, permissionKey: string, scope: PermissionScope): Promise<void> {
    const role = await this.requireRoleForOrganization(organizationId, roleId);
    if (role.isProtected) {
      throw new ForbiddenError("This role's permissions are protected and cannot be edited individually.");
    }
    this.validatePermissions([{ permissionKey, scope }]);
    await this.roles.insertPermission({ roleId, permissionKey, scope });
  }

  async removePermission(organizationId: string, roleId: string, permissionKey: string): Promise<void> {
    const role = await this.requireRoleForOrganization(organizationId, roleId);
    if (role.isProtected) {
      throw new ForbiddenError("This role's permissions are protected and cannot be edited individually.");
    }
    await this.roles.removePermission(roleId, permissionKey);
  }

  /**
   * Section 13: deleting a role requires no active memberships and no pending invitations, OR an
   * explicit reassignment target supplied up front — never an implicit/automatic reassignment. The
   * protected Owner role can never be deleted, full stop, regardless of reassignment.
   */
  async deleteRole(organizationId: string, roleId: string, reassignToRoleId?: string): Promise<void> {
    const role = await this.requireRoleForOrganization(organizationId, roleId);
    if (role.isProtected) {
      throw new ForbiddenError("This role is protected and cannot be deleted.");
    }

    const [activeMemberCount, pendingInvitationCount] = await Promise.all([
      this.roles.countActiveMembersForRole(roleId),
      this.roles.countPendingInvitationsForRole(roleId),
    ]);

    if (activeMemberCount > 0 || pendingInvitationCount > 0) {
      if (!reassignToRoleId) {
        throw new ValidationError(
          "This role has active members or pending invitations. Reassign them to another role before deleting it.",
        );
      }
      if (reassignToRoleId === roleId) {
        throw new ValidationError("Cannot reassign a role's members to the role being deleted.");
      }
      const target = await this.requireRoleForOrganization(organizationId, reassignToRoleId);
      void target;
      if (activeMemberCount > 0) await this.roles.reassignActiveMembers(roleId, reassignToRoleId);
      if (pendingInvitationCount > 0) await this.roles.reassignPendingInvitations(roleId, reassignToRoleId);
    }

    await this.roles.deleteRole(roleId);
  }

  private validatePermissions(permissions: ReadonlyArray<{ permissionKey: string; scope: PermissionScope }>): void {
    for (const p of permissions) {
      if (!isPermissionKey(p.permissionKey)) {
        throw new ValidationError(`"${p.permissionKey}" is not a recognized permission.`);
      }
      if (!isScopeSupportedForPermission(p.permissionKey, p.scope)) {
        throw new ValidationError(`The "${p.scope}" scope is not yet supported for "${p.permissionKey}".`);
      }
    }
  }

  private async requireRoleForOrganization(organizationId: string, roleId: string): Promise<OrganizationRoleRecord> {
    const role = await this.roles.findRoleForOrganization(organizationId, roleId);
    if (!role) throw new ValidationError("This role does not belong to this organization.");
    return role;
  }
}
